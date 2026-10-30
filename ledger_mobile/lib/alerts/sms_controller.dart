import 'dart:async';

import 'package:flutter/widgets.dart';

import '../api/models.dart';
import '../storage/settings_store.dart';
import 'queue.dart';
import 'sms_platform.dart';
import 'source_id.dart';
import 'sync.dart';

class SmsAlertScope extends InheritedWidget {
  const SmsAlertScope({
    super.key,
    required this.controller,
    required super.child,
  });

  final SmsAlertController? controller;

  static SmsAlertController? maybeOf(BuildContext context) {
    return context
        .dependOnInheritedWidgetOfExactType<SmsAlertScope>()
        ?.controller;
  }

  @override
  bool updateShouldNotify(SmsAlertScope oldWidget) =>
      controller != oldWidget.controller;
}

/// Opt-in, inbox backfill, and the upload of the on-device queue.
class SmsAlertController extends ChangeNotifier {
  SmsAlertController({
    required SettingsStore store,
    required this.platform,
    required this.upload,
    SmsQueueSync? queue,
    DateTime Function()? now,
  }) : queue = queue ?? SmsQueueSync(store, now: now) {
    platform.listen(_onCaptured);
  }

  final SmsPlatform platform;
  final SmsQueueSync queue;
  final Future<List<bool>> Function(List<QueuedSms> batch) upload;

  bool optIn = false;
  SmsPermission permission = SmsPermission.unknown;
  bool backfillOffered = false;
  bool offerUpgradeBackfill = false;
  SmsSyncStats stats = SmsSyncStats.empty;
  int queued = 0;
  List<String> pendingSenders = const [];
  bool _closed = false;
  Future<void>? _tail;

  DateTime now() => queue.now();

  void _onCaptured() {
    if (_closed) return;
    unawaited(flush());
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }

  Future<T> _lock<T>(Future<T> Function() action) {
    final previous = _tail ?? Future<void>.value();
    final run = previous.then<T>(
      (_) => action(),
      onError: (Object _) => action(),
    );
    _tail = run.then<void>((_) {}, onError: (Object _) {});
    return run;
  }

  Future<void> onAppOpen() => refresh();

  Future<void> refresh() {
    return _lock(() async {
      await _reloadOptIn();
      await _flushUnlocked();
      await _publish();
    });
  }

  Future<FlushResult> flush() {
    return _lock(() async {
      final result = await _flushUnlocked();
      await _publish();
      return result;
    });
  }

  /// Inbox read for the import button: the last 90 days, not only this calendar month.
  Future<int> importThisMonth() => importRecent(days: smsSenderBackfillDays);

  Future<int> importRecent({required int days, String? sender}) {
    return _lock(() => _importUnlocked(days, sender: sender));
  }

  Future<int> _importUnlocked(int days, {String? sender}) async {
    final start = smsLookbackStart(queue.now(), days);
    final rows = await platform.importInbox(from: start, to: queue.now(), sender: sender);
    final native = await platform.uploadNow();
    if (native != null) {
      _nativeQueued = native.queued;
      await queue.store.reload();
      pendingSenders = await platform.pendingSenders();
      await _publish();
      return rows.length;
    }
    final accepted = await queue.accept(
      rows,
      approved: await _approved(),
      denied: await _denied(),
    );
    if (accepted.ackIds.isNotEmpty) await platform.ack(accepted.ackIds);
    final result = await queue.flush(post: upload);
    if (result.sentIds.isNotEmpty) await platform.ack(result.sentIds);
    pendingSenders = await platform.pendingSenders();
    await _publish();
    return accepted.added;
  }

  Future<int> approveSender(String sender) {
    return _lock(() async {
      await platform.approveSender(sender);
      final added = await _importUnlocked(smsSenderBackfillDays, sender: sender);
      // Messages already held for this sender are not in the inbox read.
      await _flushUnlocked();
      await _publish();
      return added;
    });
  }

  /// One-time read of financial texts the previous allowlist dropped.
  Future<int> runUpgradeBackfill() {
    return _lock(() async {
      final added = await _importUnlocked(smsUpgradeBackfillDays);
      await queue.markUpgradeBackfillOffered();
      offerUpgradeBackfill = false;
      await _publish();
      return added;
    });
  }

  Future<void> dismissUpgradeBackfill() async {
    await queue.markUpgradeBackfillOffered();
    offerUpgradeBackfill = false;
    if (!_closed) notifyListeners();
  }

  Future<void> denySender(String sender) {
    return _lock(() async {
      await platform.denySender(sender);
      pendingSenders = await platform.pendingSenders();
      if (!_closed) notifyListeners();
    });
  }

  Future<void> markBackfillOffered() async {
    await queue.markBackfillOffered();
    await queue.markUpgradeBackfillOffered();
    backfillOffered = true;
    offerUpgradeBackfill = false;
    notifyListeners();
  }

  Future<SmsPermission> requestPermissions() async {
    permission = await platform.requestPermissions();
    notifyListeners();
    return permission;
  }

  Future<void> setOptIn(bool value) async {
    if (value) {
      permission = await platform.permissionStatus();
      if (permission != SmsPermission.granted) {
        notifyListeners();
        return;
      }
    }
    await platform.setOptIn(value);
    optIn = value;
    if (value) await platform.ensureBackgroundSync();
    notifyListeners();
  }

  Future<void> openAppSettings() => platform.openAppSettings();

  Future<void> _reloadOptIn() async {
    permission = await platform.permissionStatus();
    final flag = await platform.isOptedIn();
    if (flag && permission != SmsPermission.granted) {
      await platform.setOptIn(false);
      optIn = false;
    } else {
      optIn = flag;
    }
    backfillOffered = await queue.backfillOffered();
    offerUpgradeBackfill = optIn &&
        backfillOffered &&
        !await queue.upgradeBackfillOffered();
  }

  int? _nativeQueued;

  Future<FlushResult> _flushUnlocked() async {
    await platform.ensureBackgroundSync();
    final native = await platform.uploadNow();
    pendingSenders = await platform.pendingSenders();
    if (native != null) {
      _nativeQueued = native.queued;
      await queue.store.reload();
      final message = native.error;
      return FlushResult(
        sent: native.sent,
        kept: native.kept,
        ok: native.ok,
        error: message == null ? null : ApiException(0, message),
      );
    }
    _nativeQueued = null;
    final pending = await platform.pending();
    if (pending.isNotEmpty) {
      final accepted = await queue.accept(
        pending,
        approved: await _approved(),
        denied: await _denied(),
      );
      if (accepted.ackIds.isNotEmpty) await platform.ack(accepted.ackIds);
    }
    final result = await queue.flush(post: upload);
    if (result.sentIds.isNotEmpty) await platform.ack(result.sentIds);
    return result;
  }

  Future<Set<String>> _approved() async =>
      (await platform.approvedSenders()).map((s) => s.toLowerCase()).toSet();

  Future<Set<String>> _denied() async =>
      (await platform.deniedSenders()).map((s) => s.toLowerCase()).toSet();

  Future<void> _publish() async {
    stats = await queue.readStats();
    final nativeQueued = _nativeQueued;
    if (nativeQueued != null) {
      queued = nativeQueued;
    } else {
      await queue.outbox.load();
      queued = queue.outbox.items.length;
    }
    if (!_closed) notifyListeners();
  }
}
