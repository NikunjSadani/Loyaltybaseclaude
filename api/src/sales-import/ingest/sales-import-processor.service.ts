import { Injectable } from '@nestjs/common';
import type { SalesImport } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';

/**
 * SalesImportProcessorService — claims QUEUED (or heartbeat-stale PROCESSING) imports and turns the
 * uploaded file into SalesImportAggregate rows + frozen month summaries (plan §7.1).
 * OWNER: Lane I (tasks I-6 / I-7). Lane-0 skeleton: claimNext() finds nothing, so the worker exits 0.
 */
@Injectable()
export class SalesImportProcessorService {
  constructor(
    readonly prisma: PrismaService,
    readonly storage: StorageService,
  ) {}

  /** §7.1.1 claim (FOR UPDATE SKIP LOCKED). null = nothing claimable. */
  async claimNext(): Promise<SalesImport | null> {
    return null;
  }

  /** §7.1 steps 2–10 for one claimed import. */
  async processClaimed(_row: SalesImport): Promise<void> {
    throw new Error('SalesImportProcessorService.processClaimed: not implemented (Lane I, task I-6)');
  }
}
