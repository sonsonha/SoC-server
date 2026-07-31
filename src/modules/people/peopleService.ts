import { and, eq, ilike, isNull, asc, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/client.js';
import { people, personNotes } from '../../infrastructure/db/schema/index.js';

export class PeopleService {
  constructor(private readonly db: Db) {}

  async list() {
    return this.db
      .select()
      .from(people)
      .where(isNull(people.deletedAt))
      .orderBy(asc(people.name));
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(people)
      .where(and(eq(people.id, id), isNull(people.deletedAt)))
      .limit(1);
    if (!rows[0]) return null;
    const notes = await this.db
      .select()
      .from(personNotes)
      .where(and(eq(personNotes.personId, id), isNull(personNotes.deletedAt)))
      .orderBy(desc(personNotes.createdAt));
    return { person: rows[0], notes };
  }

  async findOrCreateByName(name: string, relationship?: string): Promise<string> {
    const existing = await this.db
      .select()
      .from(people)
      .where(and(ilike(people.name, name), isNull(people.deletedAt)))
      .limit(1);
    if (existing[0]) return existing[0].id;

    const id = randomUUID();
    const now = new Date();
    await this.db.insert(people).values({
      id,
      name,
      relationship: relationship ?? null,
      contextTags: [],
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    return id;
  }

  async addNote(personId: string, body: string): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await this.db.insert(personNotes).values({
      id,
      personId,
      body,
      createdAt: now,
      revision: 1,
      updatedAt: now,
      deletedAt: null,
    });
    return id;
  }
}
