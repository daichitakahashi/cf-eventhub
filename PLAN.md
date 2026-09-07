# Issue #135 EventHubRegistry 対応計画

## 目的

名前付き `EventHub` を自動検出する `EventHubRegistry` Durable Object を追加し、Web Console を単一の静的 instance 前提から Registry ベースの複数 instance 選択へ移行する。

Registry は discoverability のための control plane に限定し、event と delivery job を保持する各 `EventHub` は独立した data plane のままとする。Registry の消失・遅延・一時障害によって、publish、永続化、配信、redrive などの EventHub 操作を失敗させない。

## 初期リリースの設計判断

- `EventHubRegistry` は SQLite-backed Durable Object とし、その namespace 内の固定名 `default` の1 instance を Registry として使う。
  - 1件の Registry が保持するのは instance 名と lifecycle timestamp のみであり、event 本体や集計値は保持しない。
  - 一覧 API は pagination し、EventHub 側の refresh を間引いて単一 object への集中を抑える。
- EventHub subclass は Registry namespace を明示的に渡す。
  - `protected registry?: DurableObjectNamespace<EventHubRegistry>` を `EventHub` に追加し、利用者は `registry = env.EVENT_HUB_REGISTRY` と設定する。
  - Worker 環境の任意の binding 名を基底 class が安全に推測できないため、binding の接続だけは明示させる。
  - 呼び出し側は EventHub 名を再指定しない。`getByName()` / `idFromName()` で呼ばれた object が `this.ctx.id.name` から論理名を取得して自己登録する。
  - Registry 未設定の既存利用者と `newUniqueId()` / `idFromString()` で利用する unnamed instance の挙動は変えない。Web Console による自動検出を使う場合は Registry 設定を必須とする。
- Registry の同期は best-effort かつ eventual consistency とする。
  - EventHub のローカル SQLite に最後の成功時刻を保存し、成功から24時間以内は Registry RPC を省略する。
  - 同一 isolate 内では in-flight Promise を共有し、同時 activity による重複 RPC も抑える。
  - EventHub の本来の処理を完了した後にバックグラウンド同期を開始し、同期 Promise は必ず内部で例外を捕捉・構造化ログ出力する。
  - 成功時だけローカル同期時刻を更新する。失敗時は次の EventHub activity で再試行し、初期実装では専用 alarm を追加しない。
- stale threshold は Registry 内の定数として30日とし、status 判定も Registry API 内に集約する。Web Console 側で独自計算しない。
- `lastSeenAt` は「最後に Registry 同期に成功した概算時刻」であり、最新 event の発生時刻ではない。24時間の refresh 間隔があることを API と README に明記する。
- Registry の delete は discoverability の tombstone 更新だけを行い、EventHub の SQLite storage、alarm、R2 archive を削除しない。
- Web Console の選択状態は `instance=<name>` query parameter に保持する。
  - Durable Object 名に `:` などが含まれても `URLSearchParams` によって安全に扱える。
  - pagination、refresh、create、redrive、error redirect の全 URL で instance を引き継ぎ、リンク共有と page refresh の双方で選択を維持する。

## 公開 API

### Registry の型と RPC

`cf-eventhub/src/registry.ts` に以下を追加し、`cf-eventhub/src/index.ts` から export する。

```ts
export type EventHubInstanceStatus = "active" | "stale" | "deleted";

export type EventHubInstance = {
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
  deletedAt: string | null;
  status: EventHubInstanceStatus;
};

export type ListEventHubInstancesOptions = {
  status?: EventHubInstanceStatus;
  cursor?: string;
  max?: number;
};

export type ListEventHubInstancesResult = {
  instances: EventHubInstance[];
  cursor?: string;
};

export class EventHubRegistry extends DurableObject {
  async register(name: string): Promise<EventHubInstance>;
  async list(
    options?: ListEventHubInstancesOptions,
  ): Promise<ListEventHubInstancesResult>;
  async delete(name: string): Promise<boolean>;
}
```

- `register(name)` は Registry 自身の clock を使って atomic upsert する。
  - 新規名: `firstSeenAt = lastSeenAt = now`, `deletedAt = null`
  - 既存名: `firstSeenAt` を維持し、`lastSeenAt = now`, `deletedAt = null`
  - deleted 名の再登録: tombstone を解除し active に復帰
- `list()` の既定 filter は `active` とし、`status` の指定により stale / deleted を取得できるようにする。
- `max` は既定50、範囲 `1..100` とする。`name` 昇順と opaque cursor により安定して page を進める。
- lifecycle の優先順位と境界を次のように固定する。
  1. `deletedAt !== null` なら `deleted`
  2. `deletedAt === null` かつ `lastSeenAt < now - 30 days` なら `stale`
  3. それ以外は `active`
- `delete(name)` は既存 entry の `deletedAt` を設定し、既に deleted なら同じ tombstone を維持する。未登録名は新しい実体の存在を示す情報がないため tombstone を作らず `false` を返す。
- name は空文字を拒否する。Registry は byte-for-byte、case-sensitive な名前を保持し、表示名と解決名を分離しない。
- timestamp は SQLite では Unix milliseconds として比較し、RPC 境界では ISO 8601 string に変換する。

### EventHub の Registry 接続

`cf-eventhub/src/eventhub.ts` に optional な protected property と内部同期処理を追加する。

```ts
export class MyEventHub extends EventHub<Env> {
  registry = env.EVENT_HUB_REGISTRY;
  routing = routeByConfig(env, { /* ... */ });
}
```

- `this.ctx.id.name` が取得でき、かつ `registry` が設定されている instance だけを同期対象にする。
- `publish()`、`redrive()`、`list()`、`eject()`、`listEjected()`、`evict()`、`reportFailure()` と `alarm()` の activity から共通の `scheduleRegistrySync()` を呼ぶ。
- publish の成功条件は既存どおり EventHub 内の永続化と alarm 調停までとし、Registry RPC を await しない。
- Registry 同期の失敗を caller や delivery の `waitUntil()` chain に伝播させない。ログには instance 名と error を含め、payload は含めない。
- Registry 成功後のローカル時刻更新は `registry_sync_state` の singleton row に保存し、isolate eviction 後も refresh 間隔を維持する。
- `ctx.id.name` が `undefined` の場合は ID 文字列を代替名として登録しない。Registry は名前付き EventHub の discoverability に限定する。

## Registry の永続化

`cf-eventhub/src/core/registry-store.ts` を新設し、SQL と lifecycle 判定を `EventHubRegistry` から分離する。

```sql
CREATE TABLE IF NOT EXISTS eventhub_instances (
  name TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_eventhub_instances_last_seen
  ON eventhub_instances(last_seen_at);

CREATE INDEX IF NOT EXISTS idx_eventhub_instances_deleted
  ON eventhub_instances(deleted_at);
```

- constructor で idempotent に schema を初期化する。既存 `EventHub` storage とは別 namespace / database なので既存 event schema は変更しない。
- upsert、tombstone、status filter、pagination を pure store operation として実装し、時刻を引数で渡して境界を unit test 可能にする。
- active / stale の絞り込みは SQL 内で同じ cutoff を使い、返却後に Web Console が再分類しないようにする。
- Registry が失われた場合は、各 EventHub の次回同期で entry が再作成される。ただし EventHub 側に保存済みの成功時刻が残るため、復旧直後の再構築は最大24時間遅れ得る。この eventual consistency を仕様として文書化する。

`EventHub` 側の既存 schema には次を `CREATE TABLE IF NOT EXISTS` で追加する。

```sql
CREATE TABLE IF NOT EXISTS registry_sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  synced_at INTEGER NOT NULL
);
```

## Web Console の移行

### 設定と request context

`createWebConsole()` の設定を Registry 対応へ変更する。

```ts
createWebConsole({
  eventHub: { binding: "EVENT_HUB" },
  registry: { binding: "EVENT_HUB_REGISTRY" },
  environment: "production",
});
```

- `eventHub.instance` の静的設定を廃止し、`registry.binding` を必須設定として追加する。両 binding 名には分かりやすい既定値を用意する。
- `web-console/src/factory.ts` の context に Registry namespace/stub、取得済み instance 一覧、選択名、instance を保持した URL builder を追加する。
- request middleware で Registry の active 一覧を取得する。`showStale=1` の場合は stale 一覧も取得し、ページが続く間は必要な全 page を bounded call の繰り返しで取得する。
- `instance` が未指定なら active 一覧の先頭を選ぶ。active がなく stale だけの場合は明示選択を促し、Registry が空なら binding/setup と初回 EventHub activity を案内する empty state を表示する。
- query の `instance` は取得した active/stale entry に存在する場合だけ `eventHubBinding.getByName()` へ渡す。unknown / deleted の名前は直接解決せず、通常 selector からも除外する。

### UI と navigation

- header に EventHub selector を追加し、active instance を既定表示する。
- `Show stale` toggle で stale entry の表示を切り替え、stale option には status と `lastSeenAt` を明示する。stale は unavailable / deleted と表現しない。
- stale instance を選択した場合も既存の event list、create、delivery detail、redrive をそのまま利用できるようにする。
- deleted instance の管理画面と delete button は初期スコープ外とする。Registry RPC では deleted filter を提供するが、通常 UI には出さない。
- `URLSearchParams` を使う共通 helper で以下に `instance` と必要な `showStale` を伝播する。
  - top / pagination link
  - new-event notification の poll URL と reload URL
  - create event form action と validation error redirect
  - redrive form action と not-found redirect
- cursor は instance 切替時に破棄する。異なる EventHub の cursor を誤って渡さない。
- API handler は query から検証済みの選択 instance を解決し、`getEventHub()` が request ごとに正しい stub を返すようにする。
- 既存の `eventTitle`、formatter、page size、refresh、Access による保護方針は維持する。

## Wrangler、demo、型生成

- `cf-eventhub/src/test.ts` から test 用 Registry class と Registry 対応 EventHub class を export する。
- `cf-eventhub/wrangler.jsonc` に `EventHubRegistry` test class 用の新しい SQLite migration tag と `EVENT_HUB_REGISTRY` binding を追加する。
- `demo/src/index.ts` で `EventHubRegistry` を export し、`DevEventHub.registry` と Web Console の Registry binding を設定する。
- `demo/wrangler.jsonc` に Registry class の SQLite migration と binding を追加する。
- binding 変更後に各 package の `wrangler types` を実行し、`worker-configuration.d.ts` を更新する。
- Console を EventHub Worker と分離する例では、EventHub と Registry の両 binding に同じ所有 Worker の `script_name` / environment を設定することを README に記載する。

## 実装手順

1. `core/registry-store.ts` に schema、upsert、list/filter/pagination、tombstone、timestamp 変換を実装する。
2. `registry.ts` に `EventHubRegistry` と公開型、入力 validation、30日 stale 判定を追加し、`index.ts` から export する。
3. EventHub の store schema に `registry_sync_state` と読み書き helper を追加する。
4. `eventhub.ts` に optional Registry binding、24時間 throttle、in-flight deduplication、例外隔離した `scheduleRegistrySync()` を追加し、全 activity path へ接続する。
5. library の test class、Wrangler migration / binding、generated types を更新し、Registry 単体と自己登録の unit / integration test を追加する。
6. Web Console の options と request context を Registry binding ベースへ変更し、instance 解決と URL state helper を実装する。
7. active/stale selector、filter、empty/error state を UI に追加し、既存の list/create/redrive/poll/pagination を選択 instance 対応にする。
8. Web Console に handler test を追加し、instance state の伝播と lifecycle 表示を検証する。style を変更後に埋め込み CSS を再生成する。
9. demo を複数 instance と Registry の利用例へ更新し、`default`、tenant、domain partitioning の例を library / Console README に追加する。
10. 両 package の CHANGELOG と changeset に、新 API、Console 設定変更、Registry の eventual consistency / lifecycle semantics を記録する。

## テスト計画

### Unit tests (`cf-eventhub/src/core/registry-store.test.ts`)

- 初回 register が3 timestamp field を正しく作成する。
- 同名の再 register が `firstSeenAt` を維持して `lastSeenAt` だけを更新する。
- deleted entry の再 register が `deletedAt` を clear して復活させる。
- stale cutoff の直前・一致・直後を active / stale に一意に分類する。
- stale entry が時間経過だけで deleted にならない。
- delete が tombstone を作成し、再実行しても既存 `deletedAt` を変更しない。
- 未登録名の delete が `false` を返し、entry を作らない。
- active / stale / deleted filter が混同せず、name 順 pagination で重複・欠落しない。
- max、cursor、空 name の validation error を検証する。

### Integration tests (`cf-eventhub/src/registry.test.ts`, `eventhub.test.ts`)

- `getByName("tenant:acme")` の EventHub activity により同名 entry が作成される。
- Registry 同期完了を test runtime で待ち、`firstSeenAt` / `lastSeenAt` / status を Registry RPC 経由で確認する。
- 24時間以内の複数 activity は register RPC を増やさず、期限後の activity は refresh する。
- Registry register が reject しても publish の永続化、delivery、list の結果が成功する。
- 失敗時に synced timestamp を更新せず、次回 activity で再試行する。
- 同時 activity が in-flight register を共有する。
- deleted 名への EventHub activity が entry を active に戻す。
- `idFromString()` / `newUniqueId()` と Registry 未設定の EventHub は登録を試みない。
- alarm 起点の activity でも name が得られる場合は同期し、同期失敗は alarm の成功条件に影響しない。
- 既存の delivery / eviction test が Registry 未設定時にもそのまま通る。

### Web Console tests (`web-console/src/*.test.tsx`)

- instance 未指定時に先頭の active instance を選択する。
- active selector は deleted を含まず、stale は toggle 有効時だけ区別して表示する。
- stale instance を選択して通常の event list を取得できる。
- unknown / deleted の query 値を EventHub namespace へ渡さない。
- instance 切替で cursor を破棄する。
- pagination、poll、reload、create、redrive、成功・失敗 redirect が instance を保持する。
- 別 instance を選ぶと `list()`、`publish()`、`redrive()` が対応する stub にだけ送られる。
- Registry が空、Registry RPC が失敗、選択 instance の RPC が失敗した場合に判別可能な画面または response を返す。

### 検証コマンド

```sh
pnpm --filter cf-eventhub cf-typegen
pnpm --filter cf-eventhub test
pnpm --filter @cf-eventhub/web-console test
pnpm --filter @cf-eventhub/web-console build:styles
pnpm exec tsc --noEmit -p cf-eventhub/tsconfig.json
pnpm exec tsc --noEmit -p web-console/tsconfig.json
pnpm exec tsc --noEmit -p demo/tsconfig.json
pnpm exec biome check cf-eventhub/src web-console/src demo/src \
  cf-eventhub/README.md web-console/README.md
```

Web Console に test script がない現状では、実装時に Vitest の script / devDependency と Hono handler 用 mock を追加してから上記を実行する。

## 完了条件

- `EventHubRegistry` が SQLite-backed Durable Object として提供され、register / list / delete が idempotent に動作する。
- Registry が `firstSeenAt`、`lastSeenAt`、`deletedAt` と中央集約された active / stale / deleted status を返す。
- stale は非活動から導出されるだけで、自動的に tombstone または storage deletion へ移行しない。
- delete は明示的 tombstone であり、EventHub の物理 storage deletion を意味しない。
- deleted 名の自己登録によって entry が復活する。
- 名前付き EventHub は呼び出し側から名前を再入力せず自己登録し、24時間以内の不要な refresh を省く。
- Registry の障害が EventHub の永続化、配信、管理 RPC、alarm を失敗させない。
- Web Console の instance discovery は Registry のみに基づき、active を既定表示、stale を明示的に filter、deleted を通常選択から除外する。
- 選択 instance が pagination、poll、create、redrive、redirect、page refresh、共有 URL を通じて維持される。
- 選択した active / stale instance に対して既存の inspection と management 機能が動作する。
- README が小規模用途の `default`、tenant 単位、domain 単位の partitioning と、Registry の eventual consistency / 非 authoritative 性を説明する。
- test、typecheck、formatter、style build がすべて成功する。

## 非目標

- Registry を経由した publish / delivery routing
- instance 横断の event、delivery、件数、metric の集約
- Registry entry の不在や stale status を物理的な Durable Object 不在とみなすこと
- stale entry の自動 delete
- Registry delete に連動した EventHub storage / alarm / archive の破壊的削除
- deleted instance の Console 管理画面
- Registry 再構築を即時に全 EventHub へ broadcast する仕組み

## 参照

- [GitHub Issue #135: EventHubRegistry](https://github.com/daichitakahashi/cf-eventhub/issues/135)
- [Cloudflare Durable Objects: Rules and best practices](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Durable Objects: Durable Object ID](https://developers.cloudflare.com/durable-objects/api/id/)
- [Cloudflare Durable Objects: Invoke methods](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
- [Cloudflare Durable Objects: SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare Durable Objects: Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Cloudflare Workers: Context / `waitUntil()`](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [Cloudflare Wrangler: Durable Object bindings](https://developers.cloudflare.com/workers/wrangler/configuration/#durable-objects)
