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
    expect(isBankMarketing('Debit: 301XXXX123 Amt: NGN12,500.00'), isFalse);
  });

  test('parses GTBank DR and CR on device', () {
    final dr = parseBankSms(
      sender: 'GTBank',
      body: 'Acct:******1234\nAmt:NGN3,450.00 DR\nDesc:OUTWARD TRANSFER TO MONIEMFB - JOHN DOE\nBal:NGN412,890.50\nDate:2026-10-07 3:17PM',
      receivedAt: DateTime.utc(2026, 10, 7, 14, 17),
    )!;
    expect(dr.type, 'DEBIT');
    expect(dr.amountMinor, '345000');
    expect(dr.accountLast4, '1234');
    expect(dr.autoPost, isTrue);

    final cr = parseBankSms(
      sender: 'GTBank',
      body: 'Acct:******1234\nAmt:NGN518,390.25 CR\nDesc:- - PAYMENTDEEL INC-WRAMFB-GRP .\nBal:NGN540,120.80\nDate:2026-10-07 11:08AM',
    )!;
    expect(cr.type, 'CREDIT');
    expect(cr.amountMinor, '51839025');
    expect(cr.description, 'PAYMENTDEEL INC-WRAMFB-GRP');
  });

  test('parses FirstBank debit and credit and ignores marketing', () {
    final dr = parseBankSms(
      sender: 'FirstBank',
      body: 'Debit: 301XXXX123 Amt: NGN12,500.00 Date: 22-OCT-2026 18:41:09 Desc: FIP:MB:MMB/The Fresh Place / THE FRESH . Bal: NGN41,280.44CR. Dial *894*11# to get loan',
    )!;
    expect(dr.amountMinor, '1250000');
    expect(dr.description, contains('Fresh Place'));
    expect(dr.balanceAfterMinor, '4128044');

    final cr = parseBankSms(
      sender: 'FirstBank',
      body: 'Credit: 301XXXX123 Amt: NGN372,400.00 Date: 20-OCT-2026 06:22:14 Desc: FIP:FCM/JOHN SAMUEL/APIJOHN. Bal: NGN892,610.18CR Pay with FirstOnline',
    )!;
    expect(cr.type, 'CREDIT');
    expect(cr.amountMinor, '37240000');

    expect(parseBankSms(sender: 'FirstBank', body: 'Congratulations! You have a loan offer up to N300,000. Dial *894*11#'), isNull);
  });

  test('parses Sterling Money In/Out', () {
    final out = parseBankSms(
      sender: 'STERLING',
      body: 'Money Out! You have spent, NGN4,812.00 at APPLE.COM/BILL CORK         IE from ******4321 at 2026-10-08 10:15:33. You have NGN15,640.88',
    )!;
    expect(out.type, 'DEBIT');
    expect(out.amountMinor, '481200');
    expect(out.description, contains('APPLE.COM/BILL'));
    expect(out.balanceAfterMinor, '1564088');

    final inn = parseBankSms(
      sender: 'Sterling',
      body: 'Money In! NGN180,000.00 has arrived from DOE JOHN SAMUEL into ******4321 at 2026-10-11 17:36:41. You have NGN195,640.88',
    )!;
    expect(inn.type, 'CREDIT');
    expect(inn.amountMinor, '18000000');

    expect(
      parseBankSms(sender: 'STERLING', body: 'STERLING: keep transacting to stay eligible for AlwaysOn Overdraft. T&Cs apply.'),
      isNull,
    );
  });

  test('Providus stub extracts amount and counterparty bank at low confidence', () {
    final r = parseBankSms(
      sender: 'PROVIDUS',
      body: 'Debit Alert: NGN22,500.00 MOB: To MONIEPOINT MICROFINANCE BANK|truncated',
    )!;
    expect(r.type, 'DEBIT');
    expect(r.amountMinor, '2250000');
    expect(r.description, contains('MONIEPOINT'));
    expect(r.description, isNot(contains('truncated')));
    expect(r.autoPost, isFalse);
    expect(r.confidence, lessThan(0.5));
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
