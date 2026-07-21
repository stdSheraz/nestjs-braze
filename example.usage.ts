/**
 * Example: registering the module and using BrazeService in a real app.
 * This file is illustrative — copy the patterns into your own project.
 */
import { Injectable, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BrazeModule, BrazeService } from '../src';

// ---------------------------------------------------------------------------
// 1. Register once in your root module
// ---------------------------------------------------------------------------
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BrazeModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const enabled = config.get('BRAZE_ENABLED') === 'true';
        return {
          enabled,
          // strict only when enabled — app still boots without Braze env vars in dev
          endpoint: enabled
            ? config.getOrThrow<string>('BRAZE_REST_ENDPOINT')
            : 'https://rest.iad-01.braze.com',
          apiKey: enabled
            ? config.getOrThrow<string>('BRAZE_REST_API_KEY')
            : 'disabled',
        };
      },
    }),
  ],
})
export class AppModule {}

// ---------------------------------------------------------------------------
// 2. Inject BrazeService anywhere — no re-import needed (module is @Global)
// ---------------------------------------------------------------------------
interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  language?: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly braze: BrazeService) {}

  /** Same external_id as your mobile SDK's changeUser() — one profile. */
  async onUserRegistered(user: User): Promise<void> {
    await this.braze.trackUser({
      external_id: user.id,
      first_name: user.firstName,
      last_name: user.lastName,
      email: user.email,
      phone: user.phone,
      language: user.language,
      signup_source: 'backend',
    });

    await this.braze.logEvent({
      external_id: user.id,
      name: 'user_registered',
      properties: { method: 'email' },
    });
  }

  async onOrderCompleted(userId: string, order: { sku: string; total: number }) {
    await this.braze.logPurchase({
      external_id: userId,
      product_id: order.sku,
      currency: 'SAR',
      price: order.total,
    });

    await this.braze.trackUser({
      external_id: userId,
      orders_count: { inc: 1 },
    });
  }

  /** OTP must not fail silently — opt into throwing. */
  async sendOtp(userId: string, code: string): Promise<void> {
    await this.braze.triggerCampaign(
      {
        campaign_id: 'YOUR-OTP-CAMPAIGN-ID',
        recipients: [
          { external_user_id: userId, trigger_properties: { otp_code: code } },
        ],
      },
      { throwOnError: true },
    );
  }

  /** Newsletter lead before signup → merged after signup. */
  async onNewsletterSignup(email: string): Promise<void> {
    await this.braze.trackUser({
      user_alias: { alias_name: email, alias_label: 'email' },
      email,
      _update_existing_only: false,
    });
  }

  async onAccountCreatedFromLead(userId: string, email: string): Promise<void> {
    await this.braze.identifyAlias(userId, {
      alias_name: email,
      alias_label: 'email',
    });
  }

  async onGdprDeleteRequest(userId: string): Promise<void> {
    await this.braze.deleteUsers([userId], { throwOnError: true });
  }
}
