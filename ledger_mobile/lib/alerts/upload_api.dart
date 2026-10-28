import '../api/client.dart';
import '../api/models.dart';
import 'queue.dart';
import 'senders.dart';
import 'source_id.dart';

/// Posts one chunk. A 400 on a multi-message body is retried per message so one bad row
/// does not keep the rest queued. Network and rate-limit errors propagate.
Future<List<bool>> postSmsBatch(LedgerApi api, List<QueuedSms> items) async {
  if (items.isEmpty) return const [];
  if (items.any((item) => !isAllowedSmsSender(item.sender))) {
    throw StateError('Refusing to upload a non-bank SMS');
  }
  final messages = [for (final item in items) smsPayload(item)];
  try {
    final results = await api.uploadSmsBatch(messages);
    if (results.length != messages.length) {
      throw const ApiException(0, 'The server did not confirm every SMS.');
    }
    return [for (final row in results) row['status'] is String];
  } on ApiException catch (error) {
    if (error.status != 400 || items.length == 1) rethrow;
  }
  final out = <bool>[];
  for (final item in items) {
    try {
      final results = await api.uploadSmsBatch([smsPayload(item)]);
      out.add(results.length == 1 && results.single['status'] is String);
    } on ApiException {
      out.add(false);
    }
  }
  return out;
}
