/**
 * Validates req.body / req.query / req.params against zod schemas and replaces
 * them with the parsed (typed, stripped) values.
 */
export const validate =
  ({ body, query, params } = {}) =>
  (req, _res, next) => {
    try {
      if (params) req.params = params.parse(req.params);
      if (query) req.query = query.parse(req.query);
      if (body) req.body = body.parse(req.body ?? {});
      next();
    } catch (err) {
      next(err);
    }
  };
