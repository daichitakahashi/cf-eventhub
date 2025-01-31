import { Mutex } from "async-mutex";

type ReleaseFunc = () => void;

export class Locker {
  private readonly locks = new Map<string, { count: number; mu: Mutex }>();

  public async lock(id: string): Promise<ReleaseFunc> {
    let l = this.locks.get(id);
    if (l) {
      l.count++;
    } else {
      l = { count: 1, mu: new Mutex() };
      this.locks.set(id, l);
    }

    const release = await l.mu.acquire();
    return () => {
      l.count--;
      if (l.count === 0) {
        this.locks.delete(id);
      }
      release();
    };
  }
}
