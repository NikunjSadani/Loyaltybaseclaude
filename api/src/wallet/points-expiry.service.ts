import { Injectable, Logger } from '@nestjs/common';
import { Cron }               from '@nestjs/schedule';
import { WalletService }      from './wallet.service';

/**
 * Runs daily at 00:05 and expires all PointsLedger rows whose expiresAt has
 * passed.  Wallet balances are decremented atomically inside $transaction so
 * no concurrent earn/burn can race with expiry.
 */
@Injectable()
export class PointsExpiryService {
  private readonly logger = new Logger(PointsExpiryService.name);

  constructor(private readonly walletService: WalletService) {}

  @Cron('5 0 * * *')   // every day at 00:05
  async runExpiry() {
    this.logger.log('Points expiry job started');
    try {
      const { expiredCount, totalPointsExpired } =
        await this.walletService.expirePoints(null);

      this.logger.log(
        `Points expiry done: ${expiredCount} entries, ${totalPointsExpired} pts expired`,
      );
    } catch (err: any) {
      this.logger.error(`Points expiry job failed: ${err.message}`, err.stack);
    }
  }
}
