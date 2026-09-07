# Issue #133 Automatic eviction 対応計画

## 目的

`EventHub` に任意設定の automatic eviction 機能を追加し、一定期間を過ぎた finalized event を Durable Object Alarm から自動削除する。`archive` action が明示されている場合だけ、削除前に R2 へアーカイブする。

既存の `eject()`、`listEjected()`、`evict()` は公開 API として維持し、独自の Workflow を必要とする利用者にも引き続き低レベル操作を提供する。

## 初期リリースの設計判断

- 実行基盤には Cloudflare Workflows ではなく Durable Object Alarm を使う。
  - 追加の Workflow class、binding、起動処理を利用者に要求せず、`EventHub` 単体で完結できるため。
  - Durable Object が保持できる alarm は1件だけなので、配信リトライと eviction の次回実行時刻を単一のスケジューラで調停する。
- 削除方法は `action` で明示させる。
  - `{ type: "delete" }` は対象 event を transaction 内で直接削除する。
  - `{ type: "archive", bucket, prefix }` は R2 への保存成功後に削除する。初期リリースのアーカイブ先は R2 のみに限定する。
  - archive 設定の省略や binding の取得失敗を誤って直接削除として扱わない。
- 期間は既存 API の命名規則に合わせ、曖昧さのないミリ秒指定 `afterMs` とする。文字列 duration の解釈は初期スコープに含めない。
- 1回の alarm で処理する R2 put は、1ページまたはmanifestの1回だけに限定する。未完了なら直後の alarm に継続を予約し、CPU・メモリ・外部 I/O を有界にする。
- ejection ごとに決定的な object key を使い、同じページの再試行は同じ key への同一内容の再書き込みとする。全ページの保存後に completion manifest を書き、manifest の保存成功後だけ `evict()` する。
- automatic eviction が作成した ejection と手動 `eject()` の snapshot を区別する。手動 snapshot が存在するときは自動取得せず、手動ライフサイクルを優先する。
- アーカイブ処理中に eviction 設定を無効化、または action を変更した場合は snapshot を削除せず保持する。元の archive 設定で再開でき、低レベル API からも回収できる状態にする。

## 公開 API

`cf-eventhub/src/eventhub.ts` に設定型と factory を追加し、`cf-eventhub/src/index.ts` から export する。

```ts
export type EvictionAction =
  | { type: "delete" }
  | {
      type: "archive";
      bucket: R2Bucket;
      prefix: string;
    };

export type EvictionConfig = {
  afterMs: number;
  action: EvictionAction;
  batchSize: number;
};

export const configureEviction = (
  config: Pick<EvictionConfig, "afterMs" | "action"> &
    Partial<Pick<EvictionConfig, "batchSize">>,
): EvictionConfig => { /* validation and defaults */ };

export class MyEventHub extends EventHub<Env> {
  eviction = configureEviction({
    afterMs: 30 * 24 * 60 * 60 * 1000,
    action: { type: "delete" },
    batchSize: 100,
  });
}

export class MyArchivedEventHub extends EventHub<Env> {
  eviction = configureEviction({
    afterMs: 30 * 24 * 60 * 60 * 1000,
    action: {
      type: "archive",
      bucket: env.EVENT_ARCHIVE,
      prefix: "production/member-events",
    },
    batchSize: 100,
  });
}
```

- `EventHub` 側は `protected eviction?: EvictionConfig` とし、未指定時は現行挙動を変えない。
- `afterMs` は正の有限整数、`batchSize` は `1..100` の整数として検証する。既定の `batchSize` は50とする。
- `action.type` は `delete` または `archive` のみ受け入れる。`archive` の `bucket` と空でない `prefix` は必須とし、`prefix` の先頭・末尾 `/` と `//` を拒否して key の正規化差異を防ぐ。
- R2 binding は Worker の環境から直接渡せるようにする。

### R2 object key とフォーマット

application/deployment ごとの分離を利用者指定の必須 `prefix` で担保し、その配下はライブラリが決定的に生成する。payload 値や時刻文字列は key に使用しない。

```text
<prefix>/objects/<durableObjectId>/ejections/<ejectKey>/pages/000000.json
<prefix>/objects/<durableObjectId>/ejections/<ejectKey>/manifest.json
```

- `<durableObjectId>` は常に安定して取得できる `this.ctx.id.toString()` を使用し、object 単位の prefix listing を可能にする。
- Durable Object の名前は key に使わない。`this.ctx.id.name` は `idFromName()` / `getByName()` では取得できるが、`newUniqueId()`、`idFromString()`、長い名前、一部の古い alarm では `undefined` になり得るためである。
- object 名を取得できた場合だけ、page と manifest の `object.name` に任意メタデータとして格納する。canonical identity は常に `object.id` とする。
- `<ejectKey>` は snapshot の ULID を使用する。同じ object の `ejections/` 配下では辞書順がおおむね ejection 作成時刻順になるが、正式な時刻は manifest の `createdAt` と `cutoff` を参照する。
- page 番号は0始まりの6桁固定とし、辞書順と処理順を一致させる。
- page object は `formatVersion`、`object: { id, name? }`、ejection key、page index、payloads を持つ JSON envelope とし、`Content-Type: application/json` を付与する。
- manifest は `formatVersion`、`object: { id, name? }`、ejection key、cutoff、作成・完了日時、page count、payload count を持つ。
- format version は object body 内で管理し、key に `cf-eventhub/v1` のような固定 segment は加えない。
- page と manifest は再試行時にも同じ key・同じ内容を使う。manifest の存在を archive 完了の marker とする。

## 永続化と状態遷移

### Store の追加

`cf-eventhub/src/core/store.ts` に、既存データを変更せず `CREATE TABLE IF NOT EXISTS` で導入できる `eviction_runs` table と query helper を追加する。この table は `archive` action の進捗だけに使用し、`delete` action では snapshot や run を作成しない。

保持する状態:

- automatic eviction が所有する `ejection_key`
- `pages` / `manifest` の処理 phase
- 次に読む `cursor` と次の `page_index`
- 保存済み `payload_count`
- snapshot 作成時の `archive_prefix`
- snapshot 作成時の `object_id` と任意の `object_name`（再試行中は再取得せず、archive 内容を固定する）
- 再試行しても manifest 内容を変えないための `completed_at`
- `next_attempt_at`、`retry_count`、`last_error`
- 作成・更新日時

併せて以下の pure store operation を用意する。

- finalized event または delivery job を持たない event のうち、最も早い次回 eviction 対象時刻を求める。
- active ejection の有無と automatic eviction の所有権を判定する。
- `delete` action で、対象 payload、delivery job、failure record を `batchSize` 件まで同一 transaction で直接削除する。
- `archive` action で、ejection 作成と eviction run 登録を同一 `transactionSync()` で行う。
- R2 put 成功後に cursor、page index、件数を進める。
- 失敗情報と指数 backoff 後の再試行時刻を保存する。
- manifest 成功後に ejected rows、ejection、eviction run を同一 transaction で削除する。

候補 ID を列挙して大量の bind parameter を渡さず、CTE、subquery、または一時的な候補 table を使って Cloudflare SQLite の statement parameter 上限内で処理する。

ejection 対象判定は既存 `ejectPayloads()` と同じ契約を維持する。

- delivery job がある payload は、全 job が finalized かつ最も遅い `finalized_at` が cutoff より前の場合だけ対象とする。
- delivery job がない payload は `created_at` を基準にする。
- pending retry が残る payload は対象外とする。

### Alarm の統合

`cf-eventhub/src/eventhub.ts` の `scheduleNextAlarmFromStorage()` を `reconcileAlarm()` に整理し、以下の候補の最小時刻を設定する統合スケジューラにする。SQL の永続状態を唯一の正とし、alarm 自体には処理状態を持たせない。

1. 未完了 delivery job の最も早い `next_retry_at`
2. eviction run の `next_attempt_at`
3. 次に eviction 対象となる時刻（既存の厳密な `< cutoff` 条件を満たす `基準時刻 + afterMs + 1ms`）

`reconcileAlarm()` は外部 I/O を行わず、最新の SQL 状態から候補を計算した直後に `setAlarm()` または `deleteAlarm()` を呼ぶ。alarm 実行中の `getAlarm()` は次回 alarm をまだ設定していない場合 `null` を返すため、その値をスケジュールの正として使用しない。R2 I/O や任意の `await` を候補計算と alarm 更新の間に置かない。

alarm handler は delivery を先、eviction を後の順で、それぞれ最大1 batch/page だけ処理する。これにより eviction backlog が delivery retry を飢餓させず、1回の処理量を有界にする。通常完了および捕捉済みの一時エラーでは最後に `reconcileAlarm()` を実行する。

R2 の一時エラーは delivery retry を阻害しないよう個別に捕捉し、`eviction_runs` に error と指数 backoff 後の `next_attempt_at` を保存して、新しい alarm を予約したうえで正常終了する。Cloudflare の alarm 自動再試行は最大6回のため、永続的な外部障害の再試行には依存しない。予期しない例外と `reconcileAlarm()` 自体の失敗は捕捉せず、次の alarm を設定してから throw することも避け、Cloudflare の at-least-once retry に任せる。

`blockConcurrencyWhile()` や独自 lock を R2 I/O 中に保持しない。archive の排他と再開位置は `eviction_runs` の状態機械で保証し、R2 完了後は最新状態から alarm を再計算する。

新規 publish は保存直後と配信完了後に `reconcileAlarm()` を呼ぶ。これにより、配信完了時刻を基準に eviction alarm が更新される。`redrive()`、手動 `eject()`、`evict()` など他の公開 RPC でも再計算し、既存 object への設定追加や手動 snapshot の解放後に自動処理を開始できるようにする。手動 snapshot が active の間は eviction の候補時刻を alarm 計算から外し、過去時刻への即時再予約ループを防ぐ。

subclass の `eviction` field は `super()` の後に初期化されるため、base constructor では eviction alarm を設定しない。また、デプロイだけでは既存の idle Durable Object を起動できないため、設定追加後は次回 RPC、publish、または既存 alarm から有効になる制約を公開ドキュメントに明記する。

## Eviction 処理

alarm で eviction が due の場合、明示された `action.type` で処理を分岐する。

### `delete` action

1. `Date.now() - afterMs` を cutoff に、対象 payload を `batchSize` 件まで選択する。
2. 関連する failure record、delivery job、payload を同一 SQLite transaction で直接削除する。
3. 追加対象があれば直近の alarm、なければ次の eligibility 時刻を設定する。

この経路では ejection snapshot、`eviction_runs`、R2 object を作成しない。削除は `action: { type: "delete" }` を明示した場合だけ有効になり、処理途中に外部 I/O がないため batch 単位で原子的に完了する。

### `archive` action

1. automatic eviction 所有の snapshot がなければ、`Date.now() - afterMs` を cutoff に `batchSize` 件まで ejection し、run を登録する。
2. `listEjected()` 相当の store helper で現在 cursor から最大100件・payload body 合計256 KiBの1ページを読む。
3. 決定的な page key に JSON を `R2Bucket.put()` する。
4. put 成功後だけ進捗を保存する。最終ページでは安定した `completed_at` とともに phase を `manifest` に進め、直後の alarm を予約して終了する。失敗時は snapshot と cursor/phase を保持し、指数 backoff（初期1分、最大1時間）で再試行する。
5. 次の alarm が `manifest` phase なら `manifest.json` だけを保存する。manifest の再試行では page を再読込・再保存せず、保存済み `completed_at` を使用する。
6. manifest の put 成功後だけ snapshot と run を削除する。
7. 続きまたは別 batch がある場合は直近の alarm を設定し、それ以外は次の eligibility 時刻を設定する。

alarm は at-least-once なので、R2 put と SQLite 更新の間で中断した場合は同じ page を上書きする。snapshot は不変かつ query order も固定されているため内容は同一となり、重複 key は生成しない。最終 page の成功後は phase を `manifest` に永続化するため、manifest の再試行で page 0 に戻らない。R2 の Worker API は write 後に strong consistency を提供するため、成功した put を前提に次の状態へ進める。

## 設定変更時の扱い

- `afterMs` と `batchSize` の変更は、次の batch/ejection から反映する。進行中 snapshot の選択済み event は変更しない。
- eviction を無効化した状態では、新規削除、ejection、R2 put、eviction を行わない。自動 snapshot と進捗は残す。
- archive 用の run が存在する状態で action を `delete` に変えても、未アーカイブ event を直接削除しない。run を停止してエラーを構造化ログへ出し、元の archive action の再設定後に再開する。
- eviction を再有効化した場合、archive 用の保存済み run があれば現在の R2 binding で再開する。保存済み `archive_prefix` と現在値が一致しない場合は停止する。
- R2 binding の同一性は runtime から比較できないため、進行中に bucket binding の参照先を変更する操作はサポート外とする。prefix/bucket の切り替えは active run がない状態で行う。
- 既存の idle Durable Object はデプロイだけでは起動できない。eviction 設定追加後は、その object の次回 RPC/publish/alarm からスケジュールが有効になる制約を記載する。

## 実装手順

1. `eventhub.ts` に `EvictionAction`、`EvictionConfig`、`configureEviction()`、validation、既定値を追加する。
2. `store.ts` に `delete` action 用 helper を追加する。schema には archive 用の `eviction_runs` を追加し、eligibility、所有権、進捗、backoff、完了 cleanup の helper を実装する。
3. ejection の内部 helper を再利用可能に整理し、自動 ejection と run 登録を単一 transaction にする。既存の公開 ejection API の結果と singleton semantics は維持する。
4. `EventHub` に直接削除と1ページ分の archive 処理を追加し、delivery/eviction 共用の `reconcileAlarm()`、公平な alarm handler、error isolation を実装する。
5. `index.ts` から新しい factory と型を export する。
6. test Durable Object と Wrangler 設定に `delete` / `archive` action の eviction 用 class、および R2 binding を追加し、`pnpm --filter cf-eventhub cf-typegen` で binding 型を更新する。
7. README の EventHub Configuration に両 action の設定例、archive layout、再試行保証、手動 API との競合、設定変更・既存 object 起動時の制約を追記する。既存 Workflow 例は custom policy 向けの低レベル例として残す。
8. CHANGELOG（およびリポジトリのリリース運用で必要なら changeset）に追加 API と動作を記録する。

## テスト計画

### Unit tests (`core/store.test.ts`)

- `afterMs` 境界の直前・一致・直後で対象時刻を正しく計算する。
- 複数 destination のうち1件でも pending なら対象外にし、全件 finalized なら最も遅い `finalized_at` を使う。
- delivery job のない payload は `created_at` を使う。
- batch size と安定した順序で ejection する。
- `delete` action で関連 row を batch 単位で直接削除し、snapshot/run を作らないことを検証する。
- eviction run の cursor/page/count 更新、失敗 backoff、完了 cleanup を検証する。
- archive prefix の保存と設定不一致時の停止を検証する。
- archive key が `<prefix>/objects/<objectId>/ejections/<ejectKey>/...` となり、eject key と page が辞書順になることを検証する。
- object 名の有無にかかわらず key が同じ ID 基準になり、取得できた名前は再試行中も同じ任意メタデータとして使われることを検証する。
- 手動 ejection を automatic eviction が所有しないことを検証する。

### Integration tests (`eventhub.test.ts`)

- 設定なしでは既存 delivery alarm と ejection API の挙動が変わらない。
- publish/delivery 完了後、`finalized_at + afterMs` に alarm が予約される。
- delivery retry と eviction のうち早い時刻が1件の alarm に設定される。
- `delete` action は対象 event を R2 へ書き込まず削除する。
- alarm ごとに1ページずつ R2 に保存し、最後に manifest を作ってから SQLite から削除する。
- R2 put 失敗時は event を削除せず、進捗と再試行 alarm を保持する。
- put 成功後・進捗保存前を模した再実行でも同じ key だけが使われ、最終結果が重複しない。
- 途中ページから再開し、完了済みページを別 key として増殖させない。
- 最終 page と manifest を別 alarm で処理し、1回の alarm で R2 put が最大1回であることを検証する。
- manifest の再試行で key、`completed_at`、内容が変化しないことを検証する。
- 手動 ejection が active の間は automatic eviction が待機し、手動 `evict()` 後に再開する。
- eviction 無効化・再有効化で active snapshot が失われない。
- archive 処理中に action を `delete`、異なる prefix、または無効へ変更しても snapshot を直接削除しない。
- alarm 実行中の `getAlarm() === null` に依存せず、処理後に正しい次回 alarm を設定する。
- delivery と eviction の両方が due の場合に、それぞれ1 batchだけ進めて再予約する。
- R2 の一時エラーは永続 backoff で再予約し、予期しない例外は alarm handler から reject する。
- `configureEviction()` が不正な `afterMs`、`batchSize`、action、archive prefix を拒否する。

### 検証コマンド

```sh
pnpm --filter cf-eventhub cf-typegen
pnpm --filter cf-eventhub test
pnpm exec biome check cf-eventhub/src cf-eventhub/README.md cf-eventhub/CHANGELOG.md
```

## 完了条件

- 利用者が `delete` または `archive` action を明示した場合だけ automatic eviction が有効になる。
- `delete` action では対象 event が bounded batch で直接削除され、R2 object や不要な ejection snapshot は作られない。
- R2 書き込みまたは alarm の再実行が失敗しても、未アーカイブ event は eviction されない。
- archive の page key は再試行で増殖せず、manifest から snapshot の完全性を判定できる。
- archive key は必須 prefix、Durable Object ID、ejection key で衝突を避け、再試行でも安定する。format version は page と manifest の body から判定できる。
- 1 alarm あたりの event 件数、読み込み byte 数、R2 put 数が有界である。
- delivery retry と automatic eviction が同じ alarm を安全に共有する。
- 一時的な外部障害は永続 backoff で6回を超えて再試行でき、予期しない障害は Cloudflare の at-least-once retry に委ねる。
- eviction 未設定の既存利用者と低レベル ejection API に破壊的変更がない。

## 参照

- [GitHub Issue #133: Automatic eviction](https://github.com/daichitakahashi/cf-eventhub/issues/133)
- [Cloudflare Durable Objects: Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Cloudflare Durable Objects: Durable Object ID](https://developers.cloudflare.com/durable-objects/api/id/)
- [Cloudflare Durable Objects: Rules and best practices](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Durable Objects: Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Cloudflare R2: Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2: Consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
