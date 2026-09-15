import {
  isURL,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Same-origin gift-image proxy path shape the upload endpoint returns
 * (`GiftCatalogueService.uploadImage` → `/api/gift-images?key=<encoded>`).
 * Accept ONLY the exact route with an optional query string — never a longer
 * path segment (`/api/gift-imagesX`, `/api/gift-images/..`), so it can't be
 * bent into an open redirect or a different endpoint.
 */
const GIFT_IMAGE_PROXY_RE = /^\/api\/gift-images(\?|$)/;

/**
 * True iff `value` is a string that is EITHER a URL accepted by class-validator's
 * DEFAULT `@IsUrl` (`isURL` with validator.js defaults — http/https/ftp, protocol
 * optional, TLD required) OR the app's same-origin gift-image proxy path.
 *
 * We deliberately use `isURL`'s defaults (NOT a stricter option set) so the
 * accepted URLs are a STRICT SUPERSET of what the previous `@IsUrl()` accepted —
 * editing an item that stored a legacy protocol-less / ftp image URL must not
 * newly fail (that would re-introduce the very "can't save" bug this fixes).
 * Still rejected (as before): `javascript:`/`data:`/`vbscript:` schemes,
 * protocol-relative `//host`, and bare relative paths — the value renders as an
 * `<img src>`, so the surface stays tight (no XSS / open-redirect).
 */
export function isImageRef(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (GIFT_IMAGE_PROXY_RE.test(value)) return true;
  return isURL(value);
}

@ValidatorConstraint({ name: 'isImageRef', async: false })
export class IsImageRefConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    // class-validator applies `{ each: true }` for us: with that option it
    // invokes this `validate` once PER array element, so we only handle the
    // single-value case here.
    return isImageRef(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `each value in ${args.property} must be an image URL or uploaded image reference`;
  }
}

/**
 * Property decorator: the value must be an absolute http/https URL OR the
 * app's `/api/gift-images` proxy path. Pass `{ each: true }` to validate each
 * element of an array. Combine with `@IsOptional()`/`@IsArray()` as needed.
 */
export function IsImageRef(validationOptions?: ValidationOptions) {
  // eslint-disable-next-line @typescript-eslint/ban-types
  return function (object: Object, propertyName: string) {
    registerDecorator({
      name: 'isImageRef',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsImageRefConstraint,
    });
  };
}
