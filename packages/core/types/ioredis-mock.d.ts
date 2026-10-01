// Only the locked mock's methods used directly by these test fixtures are declared.
declare module 'ioredis-mock' {
  import type { Redis } from 'ioredis';

  export default class RedisMock {
    constructor();
    get: Redis['get'];
    ttl: Redis['ttl'];
    defineCommand: Redis['defineCommand'];
  }
}
