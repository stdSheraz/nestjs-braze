import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { Braze } from 'braze-api';
import { BRAZE_CLIENT, BRAZE_OPTIONS } from './braze.constants';
import {
  BrazeModuleAsyncOptions,
  BrazeModuleOptions,
} from './braze.interfaces';
import { BrazeService } from './braze.service';

@Global() // register once in AppModule, inject BrazeService anywhere
@Module({})
export class BrazeModule {
  /** Static config (fine for quick setups). */
  static forRoot(options: BrazeModuleOptions): DynamicModule {
    return {
      module: BrazeModule,
      providers: [
        { provide: BRAZE_OPTIONS, useValue: options },
        this.clientProvider(),
        BrazeService,
      ],
      exports: [BrazeService],
    };
  }

  /** Async config — the recommended way, pulling from ConfigService. */
  static forRootAsync(options: BrazeModuleAsyncOptions): DynamicModule {
    return {
      module: BrazeModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: BRAZE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        this.clientProvider(),
        BrazeService,
      ],
      exports: [BrazeService],
    };
  }

  private static clientProvider(): Provider {
    return {
      provide: BRAZE_CLIENT,
      useFactory: (opts: BrazeModuleOptions) =>
        new Braze(opts.endpoint, opts.apiKey),
      inject: [BRAZE_OPTIONS],
    };
  }
}
