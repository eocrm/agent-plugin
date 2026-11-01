import { createHash } from 'node:crypto';

export const eventId = (type, naturalKey) => `${type.slice(0, 41)}:${createHash('sha256').update(naturalKey).digest('base64url').slice(0, 22)}`;
