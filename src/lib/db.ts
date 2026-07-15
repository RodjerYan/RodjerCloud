import Dexie, { Table } from 'dexie';

export class AppDatabase extends Dexie {
  kv!: Table<{ key: string, value: any }, string>;

  constructor() {
    super('RodjerCloudDB');
    this.version(2).stores({
      kv: 'key'
    });
  }
}

export const db = new AppDatabase();
