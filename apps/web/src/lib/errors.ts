/** Thrown by web stubs of the platform seams until Epics 1+ implement them. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`)
    this.name = 'NotImplementedError'
  }
}
