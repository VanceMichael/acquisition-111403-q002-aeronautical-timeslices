import {createHash} from 'node:crypto';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export const digestJson = value => digest(Buffer.from(JSON.stringify(value)));
