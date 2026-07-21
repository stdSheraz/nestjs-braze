import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BRAZE_QUEUE, BRAZE_QUEUE_OPTIONS } from './braze-queue.constants';
import {
  BrazeQueueModuleAsyncOptions,
  BrazeQueueModuleOptions,
} from './braze-queue.interfaces';
import { BrazeQueueProcessor } from './braze-queue.processor';
import { BrazeQueueService } from './braze-queue.service';

/**
 * Opt-in module that adds durable (at-least-once) Braze delivery on top of
 * BrazeModule, backed by BullMQ + Redis. Requires `@nestjs/bullmq` and
 * `bullmq` to be installed, and BrazeModule to be registered (it provides the
 * global BrazeService the worker calls).
 *
 * Import it via the `nestjs-braze/queue` subpath so apps that don't use the
 * queue never pull in BullMQ:
 *
 *   import { BrazeQueueModule } from 'nestjs-braze/queue';
 */
@Global()
@Module({})
export class BrazeQueueModule {
  static forRoot(options: BrazeQueueModuleOptions): DynamicModule {
    return {
      module: BrazeQueueModule,
      imports: [
        BullModule.registerQueue({
          name: BRAZE_QUEUE,
          connection: options.connection,
        }),
      ],
      providers: [
        { provide: BRAZE_QUEUE_OPTIONS, useValue: options },
        ...BrazeQueueModule.workerProviders(options.runWorker),
      ],
      exports: [BrazeQueueService],
    };
  }

  static forRootAsync(options: BrazeQueueModuleAsyncOptions): DynamicModule {
    return {
      module: BrazeQueueModule,
      imports: [
        ...(options.imports ?? []),
        BullModule.registerQueueAsync({
          name: BRAZE_QUEUE,
          imports: options.imports ?? [],
          inject: options.inject ?? [],
          useFactory: async (...args: any[]) => {
            const resolved = await options.useFactory(...args);
            return { connection: resolved.connection };
          },
        }),
      ],
      providers: [
        {
          provide: BRAZE_QUEUE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        ...BrazeQueueModule.workerProviders(options.runWorker),
      ],
      exports: [BrazeQueueService],
    };
  }

  /** Producer always; worker only when runWorker !== false. */
  private static workerProviders(runWorker?: boolean): Provider[] {
    const providers: Provider[] = [BrazeQueueService];
    if (runWorker !== false) providers.push(BrazeQueueProcessor);
    return providers;
  }
}
