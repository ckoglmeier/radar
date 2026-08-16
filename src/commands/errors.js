export class CommandError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.details = details;
  }
}

export class CommandValidationError extends CommandError {
  constructor(message, details) {
    super('COMMAND_VALIDATION_FAILED', message, details);
    this.name = 'CommandValidationError';
  }
}
