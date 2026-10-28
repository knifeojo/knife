import 'dart:async';

import 'package:flutter/widgets.dart';

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
  SmsSyncStats stats = SmsSyncStats.empty;
  int queued = 0;
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

  Future<int> importThisMonth() {
    return _lock(() async {
      final start = startOfMonth(queue.now());
      final rows = await platform.importInbox(from: start, to: queue.now());
      final accepted = await queue.accept(rows);
      if (accepted.ackIds.isNotEmpty) await platform.ack(accepted.ackIds);
      await _flushUnlocked();
      await _publish();
      return accepted.added;
    });
  }

  Future<void> markBackfillOffered() async {
    await queue.markBackfillOffered();
    backfillOffered = true;
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
  }

  Future<FlushResult> _flushUnlocked() async {
    final pending = await platform.pending();
    if (pending.isNotEmpty) {
      final accepted = await queue.accept(pending);
      if (accepted.ackIds.isNotEmpty) await platform.ack(accepted.ackIds);
    }
    return queue.flush(post: upload);
  }

  Future<void> _publish() async {
    stats = await queue.readStats();
    await queue.outbox.load();
    queued = queue.outbox.items.length;
    if (!_closed) notifyListeners();
  }
}
