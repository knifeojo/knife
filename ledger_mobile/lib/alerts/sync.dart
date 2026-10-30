import 'dart:convert';

import '../storage/settings_store.dart';
import 'classifier.dart';
import 'queue.dart';
import 'source_id.dart';

class SmsSyncStats {
  const SmsSyncStats({this.captured = 0, this.sent = 0, this.lastSyncAt});

  final int captured;
  final int sent;
  final DateTime? lastSyncAt;

  static const empty = SmsSyncStats();
}

class AcceptResult {
  const AcceptResult({required this.added, required this.ackIds});

  final int added;

  /// Native queue ids to drop now. Financial texts stay until the server returns 2xx.
  final List<String> ackIds;
}

class FlushResult {
  const FlushResult({
    required this.sent,
    required this.kept,
    required this.ok,
    this.error,
    this.sentIds = const [],
  });

  final int sent;
  final int kept;
  final bool ok;
  final Object? error;
  final List<String> sentIds;
}

/// Accepts bank SMS into the outbox and uploads them. Non-bank senders are removed and never posted.
class SmsQueueSync {
  SmsQueueSync(this.store, {SmsOutbox? outbox, DateTime Function()? now})
    : outbox = outbox ?? SmsOutbox(store),
      now = now ?? DateTime.now;

  static const capturedKey = 'sms_captured';
  static const sentKey = 'sms_sent';
  static const lastSyncKey = 'sms_last_sync';
  static const backfillKey = 'sms_backfill_offered';
  static const upgradeBackfillKey = 'sms_upgrade_backfill';
  static const seenKey = 'sms_seen_ids';
  static const seenCap = 4000;

  final SettingsStore store;
  final SmsOutbox outbox;
  final DateTime Function() now;

  Future<SmsSyncStats> readStats() async {
    final captured =
        int.tryParse(await store.getString(capturedKey) ?? '') ?? 0;
    final sent = int.tryParse(await store.getString(sentKey) ?? '') ?? 0;
    final raw = await store.getString(lastSyncKey);
    final last = raw == null || raw.isEmpty ? null : DateTime.tryParse(raw);
    return SmsSyncStats(captured: captured, sent: sent, lastSyncAt: last);
  }

  Future<bool> backfillOffered() async =>
      (await store.getString(backfillKey)) == '1';

  Future<void> markBackfillOffered() => store.setString(backfillKey, '1');

  Future<bool> upgradeBackfillOffered() async =>
      (await store.getString(upgradeBackfillKey)) == '1';

  Future<void> markUpgradeBackfillOffered() =>
      store.setString(upgradeBackfillKey, '1');

  Future<AcceptResult> accept(
    List<QueuedSms> incoming, {
    Set<String> approved = const {},
    Set<String> denied = const {},
  }) async {
    await outbox.load();
    final seen = await _readSeen();
    final existing = outbox.items
        .map((item) => item.sourceId)
        .whereType<String>()
        .toSet();
    final ack = <String>[];
    final fresh = <QueuedSms>[];
    for (final raw in incoming) {
      final id = (raw.sourceId != null && raw.sourceId!.isNotEmpty)
          ? raw.sourceId!
          : smsSourceId(
              sender: raw.sender,
              body: raw.body,
              receivedAt: raw.receivedAt,
            );
      final action = senderAction(
        raw.sender,
        raw.body,
        approved: approved,
        denied: denied,
      );
      if (action == SenderAction.drop) {
        ack.add(id);
        continue;
      }
      if (action == SenderAction.ask) continue;
      if (seen.contains(id) || existing.contains(id)) continue;
      fresh.add(
        QueuedSms(
          sender: raw.sender,
          body: raw.body,
          receivedAt: raw.receivedAt.toUtc(),
          sourceId: id,
        ),
      );
      existing.add(id);
      seen.add(id);
    }
    if (fresh.isNotEmpty) {
      await outbox.enqueueAll(fresh);
      await _writeSeen(seen);
      await _bump(capturedKey, fresh.length);
    }
    return AcceptResult(added: fresh.length, ackIds: ack);
  }

  /// Posts bank messages. Anything the server does not accept stays in the outbox.
  Future<FlushResult> flush({
    required Future<List<bool>> Function(List<QueuedSms> batch) post,
    int maxBytes = 16000,
  }) async {
    await outbox.load();
    await _ensureIds();
    final dropped = outbox.items
        .where((item) => !classifyFinancialSms(item.sender, item.body).financial)
        .map((item) => item.sourceId)
        .whereType<String>()
        .toSet();
    if (dropped.isNotEmpty) await outbox.removeSourceIds(dropped);

    final pending = [...outbox.items];
    if (pending.isEmpty) return const FlushResult(sent: 0, kept: 0, ok: true);

    var sent = 0;
    var kept = 0;
    final sentIds = <String>[];
    final chunks = chunkSmsUploads(pending, maxBytes: maxBytes);
    for (var index = 0; index < chunks.length; index++) {
      final chunk = chunks[index];
      List<bool> results;
      try {
        results = await post(chunk);
      } catch (error) {
        return _finish(
          sent: sent,
          kept: _rest(chunks, index),
          ok: false,
          error: error,
          sentIds: sentIds,
        );
      }
      if (results.length != chunk.length) {
        return _finish(
          sent: sent,
          kept: _rest(chunks, index),
          ok: false,
          sentIds: sentIds,
        );
      }
      final remove = <String>[];
      for (var i = 0; i < chunk.length; i++) {
        final id = chunk[i].sourceId;
        if (id == null) continue;
        if (results[i]) {
          remove.add(id);
          sentIds.add(id);
          sent++;
        } else {
          await outbox.markRetried(id);
          kept++;
        }
      }
      await outbox.removeSourceIds(remove.toSet());
    }
    return _finish(sent: sent, kept: kept, ok: kept == 0, sentIds: sentIds);
  }

  Future<void> _ensureIds() async {
    var changed = false;
    final next = <QueuedSms>[];
    for (final item in outbox.items) {
      if (item.sourceId != null && item.sourceId!.isNotEmpty) {
        next.add(item);
        continue;
      }
      changed = true;
      next.add(
        QueuedSms(
          sender: item.sender,
          body: item.body,
          receivedAt: item.receivedAt,
          sourceId: smsSourceId(
            sender: item.sender,
            body: item.body,
            receivedAt: item.receivedAt,
          ),
          attempts: item.attempts,
        ),
      );
    }
    if (changed) await outbox.replaceAll(next);
  }

  Future<FlushResult> _finish({
    required int sent,
    required int kept,
    required bool ok,
    Object? error,
    List<String> sentIds = const [],
  }) async {
    if (sent > 0) {
      await _bump(sentKey, sent);
      await store.setString(lastSyncKey, now().toUtc().toIso8601String());
    }
    return FlushResult(
      sent: sent,
      kept: kept,
      ok: ok,
      error: error,
      sentIds: sentIds,
    );
  }

  int _rest(List<List<QueuedSms>> chunks, int from) {
    var count = 0;
    for (var i = from; i < chunks.length; i++) {
      count += chunks[i].length;
    }
    return count;
  }

  Future<void> _bump(String key, int by) async {
    if (by <= 0) return;
    final current = int.tryParse(await store.getString(key) ?? '') ?? 0;
    await store.setString(key, '${current + by}');
  }

  Future<Set<String>> _readSeen() async {
    final raw = await store.getString(seenKey);
    if (raw == null || raw.isEmpty) return {};
    try {
      final list = jsonDecode(raw);
      if (list is List) return list.whereType<String>().toSet();
    } on FormatException {
      return {};
    }
    return {};
  }

  Future<void> _writeSeen(Set<String> seen) async {
    final list = seen.toList();
    final trimmed = list.length > seenCap
        ? list.sublist(list.length - seenCap)
        : list;
    await store.setString(seenKey, jsonEncode(trimmed));
  }
}
