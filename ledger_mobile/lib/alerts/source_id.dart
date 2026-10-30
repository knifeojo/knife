import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'queue.dart';

/// Same bytes as `smsSourceId` in the Android receiver. Live capture and the
/// inbox backfill of one message share this id, which is the server's SMS idempotency key.
String smsSourceId({
  required String sender,
  required String body,
  required DateTime receivedAt,
}) {
  final millis = receivedAt.toUtc().millisecondsSinceEpoch;
  return sha256.convert(utf8.encode('sms|$sender|$millis|$body')).toString();
}

/// Local midnight on the first day of [now]'s month.
DateTime startOfMonth(DateTime now) {
  final local = now.toLocal();
  return DateTime(local.year, local.month, 1);
}

const monthNames = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

String monthStartLabel(DateTime now) {
  final local = now.toLocal();
  return '1 ${monthNames[local.month - 1]} ${local.year}';
}

/// What `POST /api/v1/alerts/sms` needs. The server dedups on `sourceId` within SMS, and
/// parses `body` (amount, direction, account, narration, balance, date) to merge with
/// email and statement rows. `receivedAt` is the original SMS time, used when the text has no date.
Map<String, Object?> smsPayload(QueuedSms sms) {
  final id = (sms.sourceId != null && sms.sourceId!.isNotEmpty)
      ? sms.sourceId!
      : smsSourceId(
          sender: sms.sender,
          body: sms.body,
          receivedAt: sms.receivedAt,
        );
  return {
    'sender': sms.sender,
    'body': sms.body,
    'receivedAt': sms.receivedAt.toUtc().toIso8601String(),
    'sourceId': id,
  };
}

int smsBatchBytes(List<QueuedSms> items) {
  return utf8
      .encode(
        jsonEncode({
          'messages': [for (final item in items) smsPayload(item)],
        }),
      )
      .length;
}

/// Stay under the server's 20KB JSON limit. A single message that is larger goes alone.
List<List<QueuedSms>> chunkSmsUploads(
  List<QueuedSms> items, {
  int maxBytes = 16000,
}) {
  final chunks = <List<QueuedSms>>[];
  var current = <QueuedSms>[];
  for (final item in items) {
    if (current.isEmpty) {
      current = [item];
      continue;
    }
    if (smsBatchBytes([...current, item]) > maxBytes) {
      chunks.add(current);
      current = [item];
    } else {
      current = [...current, item];
    }
  }
  if (current.isNotEmpty) chunks.add(current);
  return chunks;
}

String smsCountLabel({
  required int captured,
  required int sent,
  required int queued,
}) {
  final base = 'Captured $captured · Sent $sent';
  if (queued <= 0) return base;
  final noun = queued == 1 ? '1 waiting' : '$queued waiting';
  return '$base · $noun';
}

String smsLastSyncLabel(DateTime? at) {
  if (at == null) return 'Last synced: never';
  final local = at.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return 'Last synced: ${local.year}-${two(local.month)}-${two(local.day)} ${two(local.hour)}:${two(local.minute)}';
}
