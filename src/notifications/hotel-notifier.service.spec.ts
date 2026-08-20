import { createHmac } from 'node:crypto';
import { PaymentConfig } from '../config/payment.config';
import { HotelNotifierService } from './hotel-notifier.service';

describe('HotelNotifierService', () => {
  const secret = 'shared-secret';
  let fetchMock: jest.MockedFunction<typeof fetch>;
  let service: HotelNotifierService;

  beforeEach(() => {
    fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = fetchMock;
    service = new HotelNotifierService({
      hotelBaseUrl: 'https://api.example.test',
      hotelNotificationSigningSecret: secret,
      hotelTimeoutMs: 5000,
    } as PaymentConfig);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('signs timestamp plus body and posts to the hotel notifications route', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ duplicate: false }), { status: 200 }),
    );
    const payload = { eventId: 'evt_1', amount: '8700.00' };

    const result = await service.send('evt_1', payload);

    expect(result.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.example.test/internal/payments/notifications',
    );
    const headers = init.headers as Record<string, string>;
    const timestamp = headers['X-Alterera-Timestamp'];
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${JSON.stringify(payload)}`)
      .digest('hex');
    expect(headers['X-Alterera-Signature']).toBe(expected);
    expect(headers['X-Alterera-Event-Id']).toBe('evt_1');
  });
});
