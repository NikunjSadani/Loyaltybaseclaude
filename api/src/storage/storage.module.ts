import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/** Global so any domain (kyc docs, visibility submissions, report exports) can inject StorageService. */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
