import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Global: the queue, the realtime gateway and the readiness probe all want the
 * same connection rather than one each.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
