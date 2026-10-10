import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { inferSchema } from '../src/connectors/schema-inference';

describe('inferSchema', () => {
  it('merges types, presence and nested paths across documents', () => {
    const fields = inferSchema(
      [
        { _id: new ObjectId(), name: 'a', address: { city: 'Cairo' } },
        { _id: new ObjectId(), name: null, age: 3 },
      ],
      ['_id'],
    );
    const byPath = Object.fromEntries(fields.map((field) => [field.path, field]));

    expect(fields[0].path).toBe('_id');
    expect(byPath._id).toMatchObject({ type: 'objectId', primaryKey: true, presence: 1 });
    expect(byPath.name).toMatchObject({ type: 'string', nullable: true });
    expect(byPath['address.city']).toMatchObject({ type: 'string', presence: 0.5 });
    expect(byPath.age).toMatchObject({ type: 'number', nullable: true });
  });
});
