export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }

  static badRequest(message, details) {
    return new ApiError(400, message, details);
  }
  static unauthorized(message = 'Please sign in to continue.') {
    return new ApiError(401, message);
  }
  static forbidden(message = 'You do not have permission to do this.') {
    return new ApiError(403, message);
  }
  static notFound(message = 'Not found.') {
    return new ApiError(404, message);
  }
  static conflict(message, details) {
    return new ApiError(409, message, details);
  }
}
