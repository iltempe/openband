export class ConflictError extends Error {
  constructor(readonly etag: string) {
    super('The project changed elsewhere');
  }
}
