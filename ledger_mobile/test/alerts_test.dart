import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ledger_mobile/alerts/parsers.dart';
import 'package:ledger_mobile/alerts/queue.dart';
import 'package:ledger_mobile/alerts/senders.dart';
import 'package:ledger_mobile/api/client.dart';
import 'package:ledger_mobile/storage/settings_store.dart';

void main() {
  test('sender allowlist drops telcos and phone numbers', () {
    expect(isAllowedSmsSender('GTBank'), isTrue);
    expect(isAllowedSmsSender('FirstBank'), isTrue);
    expect(isAllowedSmsSender('STERLING'), isTrue);
    expect(isAllowedSmsSender('303'), isFalse);
    expect(isAllowedSmsSender('GloDataSale'), isFalse);
    expect(isAllowedSmsSender('GLO-ROAM'), isFalse);
    expect(isAllowedSmsSender('VIDEO'), isFalse);
    expect(isAllowedSmsSender('getmigo'), isFalse);
    expect(isAllowedSmsSender('MYD ALERT'), isFalse);
    expect(isAllowedSmsSender('+2348012345678'), isFalse);
    expect(isPhoneSender('08012345678'), isTrue);
    expect(isBankMarketing('Congratulations! You have a loan offer up to N300,000'), isTrue);
    expect(isBankMarketing('Debit: 309XXXX867 Amt: NGN10,000.00'), isFalse);
  });

  test('parses GTBank DR and CR on device', () {
    final dr = parseBankSms(
      sender: 'GTBank',
      body: 'Acct:******1234\nAmt:NGN2,800.00 DR\nDesc:OUTWARD TRANSFER TO MONIEMFB - JOHN DOE\nBal:NGN354,145.94\nDate:2026-10-03 4:29PM',
      receivedAt: DateTime.utc(2026, 10, 3, 15, 29),
    )!;
    expect(dr.type, 'DEBIT');
    expect(dr.amountMinor, '280000');
    expect(dr.accountLast4, '1234');
    expect(dr.autoPost, isTrue);

    final cr = parseBankSms(
      sender: 'GTBank',
      body: 'Acct:******1234\nAmt:NGN645,242.76 CR\nDesc:- - PAYMENTDEEL INC-WRAMFB-GRP .\nBal:NGN672,045.70\nDate:2026-10-03 1:23PM',
    )!;
    expect(cr.type, 'CREDIT');
    expect(cr.amountMinor, '64524276');
    expect(cr.description, 'PAYMENTDEEL INC-WRAMFB-GRP');
  });

  test('parses FirstBank debit and credit and ignores marketing', () {
    final dr = parseBankSms(
      sender: 'FirstBank',
      body: 'Debit: 309XXXX867 Amt: NGN10,000.00 Date: 29-SEP-2026 19:50:38 Desc: FIP:MB:MMB/The Fresh Place / THE FRESH . Bal: NGN30,159.33CR. Dial *894*11# to get loan',
    )!;
    expect(dr.amountMinor, '1000000');
    expect(dr.description, contains('Fresh Place'));

    final cr = parseBankSms(
      sender: 'FirstBank',
      body: 'Credit: 309XXXX867 Amt: NGN485,750.00 Date: 26-SEP-2026 04:18:32 Desc: FIP:FCM/JOHN SAMUEL/APIJOHN. Bal: NGN1,249,349.61CR Pay with FirstOnline',
    )!;
    expect(cr.type, 'CREDIT');
    expect(cr.amountMinor, '48575000');

    expect(parseBankSms(sender: 'FirstBank', body: 'Congratulations! You have a loan offer up to N300,000. Dial *894*11#'), isNull);
  });

  test('parses Sterling Money In/Out', () {
    final out = parseBankSms(
      sender: 'STERLING',
      body: 'Money Out! You have spent, NGN6,969.00 at APPLE.COM/BILL CORK         IE from ******8537 at 2026-09-25 13:48:14. You have NGN8,790.31',
    )!;
    expect(out.type, 'DEBIT');
    expect(out.amountMinor, '696900');
    expect(out.description, contains('APPLE.COM/BILL'));

    final inn = parseBankSms(
      sender: 'Sterling',
      body: 'Money In! NGN250,000.00 has arrived from DOE JOHN SAMUEL into ******8537 at 2026-09-30 18:24:12. You have NGN256,176.61',
    )!;
    expect(inn.type, 'CREDIT');
    expect(inn.amountMinor, '25000000');
  });

  test('offline queue persists and the API posts sender+body', () async {
    final store = MemorySettingsStore();
    final box = SmsOutbox(store);
    await box.enqueue(QueuedSms(sender: 'GTBank', body: 'Amt:NGN1.00 DR', receivedAt: DateTime.utc(2026, 10, 3), sourceId: 'q1'));
    final again = SmsOutbox(store);
    await again.load();
    expect(again.items.single.sender, 'GTBank');
    expect(again.items.single.sourceId, 'q1');

    late http.Request seen;
    final api = LedgerApi(
      baseUrl: 'http://100.64.0.8:3000',
      token: 'session-token-value',
      httpClient: MockClient((request) async {
        seen = request;
        return http.Response('{"results":[{"status":"created"}]}', 200, headers: {'content-type': 'application/json'});
      }),
    );
    await api.uploadSms(sender: 'GTBank', body: 'Amt:NGN1.00 DR', receivedAt: DateTime.utc(2026, 10, 3));
    expect(seen.url.path, '/api/v1/alerts/sms');
    expect(seen.body, contains('GTBank'));
    expect(seen.headers['authorization'], 'Bearer session-token-value');
  });
}
