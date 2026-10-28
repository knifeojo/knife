import 'dart:convert';

import 'package:flutter/services.dart';

import 'queue.dart';
import 'source_id.dart';

enum SmsPermission { granted, denied, permanentlyDenied, unavailable, unknown }

/// Android bridge for the opt-in flag, runtime SMS permission, and the inbox read.
abstract class SmsPlatform {
  Future<bool> isOptedIn();
  Future<void> setOptIn(bool value);
  Future<SmsPermission> permissionStatus();
  Future<SmsPermission> requestPermissions();
  Future<void> openAppSettings();
  Future<List<QueuedSms>> pending();
  Future<void> ack(List<String> sourceIds);
  Future<List<QueuedSms>> importInbox({
    required DateTime from,
    required DateTime to,
  });
  void listen(void Function() onCaptured);
}

class MethodChannelSmsPlatform implements SmsPlatform {
  MethodChannelSmsPlatform({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('ledger/sms');

  final MethodChannel _channel;

  @override
  Future<bool> isOptedIn() async => await _invoke<bool>('isOptedIn') ?? false;

  @override
  Future<void> setOptIn(bool value) async {
    await _invoke<bool>('setOptIn', {'value': value});
  }

  @override
  Future<SmsPermission> permissionStatus() async =>
      _permission(await _invoke<String>('permissionStatus'));

  @override
  Future<SmsPermission> requestPermissions() async =>
      _permission(await _invoke<String>('requestPermissions'));

  @override
  Future<void> openAppSettings() async {
    await _invoke<bool>('openSettings');
  }

  @override
  Future<List<QueuedSms>> pending() async =>
      _decode(await _invoke<String>('pending'));

  @override
  Future<void> ack(List<String> sourceIds) async {
    if (sourceIds.isEmpty) return;
    await _invoke<bool>('ack', {'ids': sourceIds});
  }

  @override
  Future<List<QueuedSms>> importInbox({
    required DateTime from,
    required DateTime to,
  }) async {
    return _decode(
      await _invoke<String>('importInbox', {
        'fromMs': from.millisecondsSinceEpoch,
        'toMs': to.millisecondsSinceEpoch,
      }),
    );
  }

  @override
  void listen(void Function() onCaptured) {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'onCaptured') onCaptured();
    });
  }

  Future<T?> _invoke<T>(String method, [Object? arguments]) async {
    try {
      return await _channel.invokeMethod<T>(method, arguments);
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  SmsPermission _permission(String? value) {
    switch (value) {
      case 'granted':
        return SmsPermission.granted;
      case 'denied':
        return SmsPermission.denied;
      case 'permanently_denied':
        return SmsPermission.permanentlyDenied;
      default:
        return SmsPermission.unavailable;
    }
  }

  List<QueuedSms> _decode(String? raw) {
    if (raw == null || raw.isEmpty) return const [];
    final decoded = jsonDecode(raw);
    if (decoded is! List) return const [];
    final out = <QueuedSms>[];
    for (final item in decoded) {
      if (item is! Map) continue;
      final sms = queuedFromNative(Map<String, dynamic>.from(item));
      if (sms != null) out.add(sms);
    }
    return out;
  }
}

/// Native queue rows use epoch milliseconds. Non-bank rows are still parsed so the caller can drop them.
QueuedSms? queuedFromNative(Map<String, dynamic> json) {
  final sender = json['sender'];
  final body = json['body'];
  if (sender is! String || body is! String) return null;
  final received = json['receivedAt'];
  final DateTime at;
  if (received is int) {
    at = DateTime.fromMillisecondsSinceEpoch(received, isUtc: true);
  } else if (received is num) {
    at = DateTime.fromMillisecondsSinceEpoch(received.toInt(), isUtc: true);
  } else if (received is String) {
    at = DateTime.parse(received).toUtc();
  } else {
    return null;
  }
  final given = json['id'];
  final id = given is String && given.isNotEmpty
      ? given
      : smsSourceId(sender: sender, body: body, receivedAt: at);
  return QueuedSms(sender: sender, body: body, receivedAt: at, sourceId: id);
}
