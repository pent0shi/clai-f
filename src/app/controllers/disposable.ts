export interface Disposable {
  dispose(): void;
}


export class CompositeDisposable implements Disposable {
  private readonly items: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.push(item);
    return item;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      try {
        this.items[i]?.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.items.length = 0;
    if (errors.length > 0) throw errors[0];
  }
}
