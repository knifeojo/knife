import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ledger_mobile/alerts/queue.dart';
import 'package:ledger_mobile/alerts/senders.dart';
import 'package:ledger_mobile/alerts/sms_controller.dart';
import 'package:ledger_mobile/alerts/sms_platform.dart';
import 'package:ledger_mobile/alerts/source_id.dart';
import 'package:ledger_mobile/alerts/sync.dart';
import 'package:ledger_mobile/alerts/upload_api.dart';
import 'package:ledger_mobile/api/client.dart';
import 'package:ledger_mobile/api/models.dart';
import 'package:ledger_mobile/storage/settings_store.dart';

const _body =
    'Acct:******1234\nAmt:NGN3,450.00 DR\nDesc:POS PURCHASE\nBal:NGN10,000.00';

QueuedSms _bank({
  String sender = 'GTBank',
  String? sourceId,
  DateTime? at,
  String body = _body,
}) {
  final receivedAt = at ?? DateTime.utc(2026, 10, 4, 8, 30);
  return QueuedSms(
    sender: sender,
    body: body,
    receivedAt: receivedAt,
    sourceId:
        sourceId ??
        smsSourceId(sender: sender, body: body, receivedAt: receivedAt),
  );
}

void main() {
  test('source id matches the Android hash of sender, time and body', () {
    final at = DateTime.fromMillisecondsSinceEpoch(1728314220000, isUtc: true);
    expect(
      smsSourceId(sender: 'GTBank', body: 'Amt:NGN1.00 DR', receivedAt: at),
      '07a201ac2b63604ba6c95c53591dcfa22a4f637cafe494fe1e1e87ffa79486b6',
    );
    expect(
      smsSourceId(sender: 'GTBank', body: 'Amt:NGN1.00 DR', receivedAt: at),
      smsSourceId(sender: 'GTBank', body: 'Amt:NGN1.00 DR', receivedAt: at),
    );
  });

  test('month backfill starts at local midnight on the 1st', () {
    expect(startOfMonth(DateTime(2026, 10, 28, 18, 4)), DateTime(2026, 10, 1));
    expect(monthStartLabel(DateTime(2026, 10, 28, 18, 4)), '1 October 2026');
  });

  test('chunks stay under the server JSON limit', () {
    final items = [
      for (var i = 0; i < 8; i++)
        _bank(
          sourceId: 'id$i',
          at: DateTime.utc(2026, 10, 1, 0, i),
          body: 'Amt:NGN1.00 DR ${'x' * 1800} $i',
        ),
    ];
    final chunks = chunkSmsUploads(items, maxBytes: 5000);
    expect(chunks.length, greaterThan(1));
    expect(chunks.expand((chunk) => chunk).length, items.length);
    for (final chunk in chunks) {
      expect(smsBatchBytes(chunk) <= 5000 || chunk.length == 1, isTrue);
    }
  });

  test('accept drops non-bank SMS and counts each bank message once', () async {
    final sync = SmsQueueSync(
      MemorySettingsStore(),
      now: () => DateTime.utc(2026, 10, 28, 18),
    );
    final bank = _bank();
    final phone = QueuedSms(
      sender: '08031234567',
      body: 'See you at 6',
      receivedAt: bank.receivedAt,
      sourceId: 'phone-1',
    );
    final telco = QueuedSms(
      sender: 'MTN',
      body: 'You have won a prize',
      receivedAt: bank.receivedAt,
      sourceId: 'telco-1',
    );

    final first = await sync.accept([bank, bank, phone, telco]);
    expect(first.added, 1);
    expect(first.ackIds, containsAll([bank.sourceId, 'phone-1', 'telco-1']));
    expect(sync.outbox.items.map((item) => item.sender), ['GTBank']);

    final again = await sync.accept([bank]);
    expect(again.added, 0);
    expect((await sync.readStats()).captured, 1);
  });

  test(
    'upload sends dedup fields and removes a message only after success',
    () async {
      final sync = SmsQueueSync(
        MemorySettingsStore(),
        now: () => DateTime.utc(2026, 10, 28, 18, 4),
      );
      final bank = _bank();
      final phone = QueuedSms(
        sender: '+2348011122233',
        body: 'personal note',
        receivedAt: bank.receivedAt,
        sourceId: 'phone-2',
      );
      await sync.outbox.enqueue(phone);
      await sync.accept([bank]);

      var calls = 0;
      final failed = await sync.flush(
        post: (batch) async {
          calls += 1;
          expect(batch.map((item) => item.sender), ['GTBank']);
          expect(batch.single.body, _body);
          expect(
            batch.single.receivedAt.toUtc().toIso8601String(),
            '2026-10-04T08:30:00.000Z',
          );
          expect(batch.single.sourceId, bank.sourceId);
          throw const ApiException(0, 'offline');
        },
      );
      expect(failed.ok, isFalse);
      expect(failed.sent, 0);
      expect(sync.outbox.items.map((item) => item.sourceId), [bank.sourceId]);
      expect((await sync.readStats()).sent, 0);
      expect((await sync.readStats()).lastSyncAt, isNull);

      final sent = await sync.flush(
        post: (batch) async {
          calls += 1;
          expect(batch.single.sourceId, bank.sourceId);
          return [true];
        },
      );
      expect(sent.sent, 1);
      expect(sync.outbox.items, isEmpty);
      expect(calls, 2);
      final stats = await sync.readStats();
      expect(stats.captured, 1);
      expect(stats.sent, 1);
      expect(stats.lastSyncAt, isNotNull);
    },
  );

  test(
    'a partial batch keeps only the messages the server did not accept',
    () async {
      final sync = SmsQueueSync(MemorySettingsStore());
      final ok = _bank(sourceId: 'ok');
      final held = _bank(
        sender: 'FirstBank',
        sourceId: 'held',
        body: 'Debit: 301XXXX123 Amt: NGN1.00 Date: 01-OCT-2026 00:00:00 Desc: POS Bal: NGN2.00CR',
      );
      await sync.accept([ok, held]);
      final result = await sync.flush(
        post: (batch) async => [
          for (final item in batch) item.sourceId == 'ok',
        ],
      );
      expect(result.sent, 1);
      expect(result.kept, 1);
      expect(sync.outbox.items.single.sourceId, 'held');
      expect(sync.outbox.items.single.attempts, 1);
      expect((await sync.readStats()).sent, 1);
    },
  );

  test('payload carries sender, body, receivedAt and sourceId, and refuses other senders', () async {
    final bank = _bank();
    final requests = <String>[];
    final api = LedgerApi(
      baseUrl: 'http://100.64.0.8:3000',
      token: 'session-token-value',
      httpClient: MockClient((request) async {
        requests.add(request.body);
        final messages = (jsonDecode(request.body) as Map)['messages'] as List;
        if (messages.length > 1) {
          return http.Response(
            '{"error":"bad row"}',
            400,
            headers: {'content-type': 'application/json'},
          );
        }
        final sender = (messages.single as Map)['sender'];
        if (sender == 'GTBank') {
          return http.Response(
            '{"results":[{"status":"created"}]}',
            200,
            headers: {'content-type': 'application/json'},
          );
        }
        return http.Response(
          '{"error":"receivedAt is not a date"}',
          400,
          headers: {'content-type': 'application/json'},
        );
      }),
    );

    final bad = _bank(
      sender: 'Sterling',
      sourceId: 'bad',
      body: 'Money Out! not a full alert',
    );
    final accepted = await postSmsBatch(api, [bank, bad]);
    expect(accepted, [true, false]);
    expect(requests.first, contains('"messages"'));
    final first = jsonDecode(requests[1]) as Map;
    final message = (first['messages'] as List).single as Map;
    expect(message['sender'], 'GTBank');
    expect(message['body'], _body);
    expect(message['receivedAt'], '2026-10-04T08:30:00.000Z');
    expect(message['sourceId'], bank.sourceId);
    expect(requests.join('\n'), isNot(contains('0803')));
    expect(requests.join('\n'), isNot(contains('personal')));

    await expectLater(
      postSmsBatch(api, [
        QueuedSms(
          sender: 'GloDataSale',
          body: 'data bundle',
          receivedAt: bank.receivedAt,
          sourceId: 'glo',
        ),
      ]),
      throwsA(isA<StateError>()),
    );
    expect(requests, hasLength(3));
    expect(isAllowedSmsSender('GloDataSale'), isFalse);
  });

  test(
    'app open uploads the native queue and leaves failures queued',
    () async {
      final platform = _FakeSmsPlatform();
      final posted = <QueuedSms>[];
      final sms = SmsAlertController(
        store: MemorySettingsStore(),
        platform: platform,
        upload: (batch) async {
          posted.addAll(batch);
          if (batch.any((item) => item.sourceId == 'fail')) {
            throw const ApiException(0, 'offline');
          }
          return List.filled(batch.length, true);
        },
        now: () => DateTime(2026, 10, 28, 18, 4),
      );
      final bank = _bank();
      final telco = QueuedSms(
        sender: 'Airtel',
        body: 'promo',
        receivedAt: bank.receivedAt,
        sourceId: 'airtel',
      );
      platform.nativeQueue.addAll([bank, telco]);

      await sms.onAppOpen();
      expect(posted.map((item) => item.sender), ['GTBank']);
      expect(posted.single.sourceId, bank.sourceId);
      expect(platform.nativeQueue, isEmpty);
      expect(sms.stats.captured, 1);
      expect(sms.stats.sent, 1);
      expect(sms.queued, 0);
      expect(
        smsLastSyncLabel(sms.stats.lastSyncAt),
        smsLastSyncLabel(DateTime(2026, 10, 28, 18, 4)),
      );

      final failed = _bank(sender: 'FirstBank', sourceId: 'fail');
      platform.nativeQueue.add(failed);
      platform.captured?.call();
      await sms.flush();
      expect(sms.queued, 1);
      expect(sms.outboxItems.single.sourceId, 'fail');
      sms.dispose();
    },
  );
}

extension on SmsAlertController {
  List<QueuedSms> get outboxItems => queue.outbox.items;
}

class _FakeSmsPlatform implements SmsPlatform {
  SmsPermission permission = SmsPermission.granted;
  bool optIn = false;
  final List<QueuedSms> nativeQueue = [];
  void Function()? captured;

  @override
  Future<void> ack(List<String> sourceIds) async {
    final drop = sourceIds.toSet();
    nativeQueue.removeWhere(
      (item) => item.sourceId != null && drop.contains(item.sourceId),
    );
  }

  @override
  Future<List<QueuedSms>> importInbox({
    required DateTime from,
    required DateTime to,
  }) async => const [];

  @override
  Future<bool> isOptedIn() async => optIn;

  @override
  void listen(void Function() onCaptured) => captured = onCaptured;

  @override
  Future<void> openAppSettings() async {}

  @override
  Future<List<QueuedSms>> pending() async => List.of(nativeQueue);

  @override
  Future<SmsPermission> permissionStatus() async => permission;

  @override
  Future<SmsPermission> requestPermissions() async => permission;

  @override
  Future<void> setOptIn(bool value) async => optIn = value;
}
