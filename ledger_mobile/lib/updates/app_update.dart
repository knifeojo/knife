import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// True when the published build should replace the one on the phone.
bool isNewerBuild(int localBuild, int remoteBuild) => remoteBuild > localBuild;

class UpdateOffer {
  const UpdateOffer({
    required this.ready,
    this.version,
    this.buildNumber,
  });

  final bool ready;
  final String? version;
  final int? buildNumber;

  static UpdateOffer? fromMap(Map<Object?, Object?> raw) {
    int? asInt(Object? value) {
      if (value is int) return value;
      if (value is num) return value.toInt();
      return null;
    }

    final version = raw['version'];
    return UpdateOffer(
      ready: raw['ready'] == true,
      version: version is String && version.isNotEmpty ? version : null,
      buildNumber: asInt(raw['buildNumber']),
    );
  }
}

abstract class AppUpdatePlatform {
  Future<UpdateOffer?> check();
  Future<UpdateOffer?> ready();
  Future<void> install();
  Future<void> ensureDaily();
}

class MethodChannelAppUpdate implements AppUpdatePlatform {
  MethodChannelAppUpdate({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('ledger/update');

  final MethodChannel _channel;

  @override
  Future<UpdateOffer?> check() => _offer('check');

  @override
  Future<UpdateOffer?> ready() => _offer('ready');

  @override
  Future<void> install() async {
    try {
      await _channel.invokeMethod<bool>('install');
    } on MissingPluginException {
      return;
    } on PlatformException {
      return;
    }
  }

  @override
  Future<void> ensureDaily() async {
    try {
      await _channel.invokeMethod<bool>('ensureDaily');
    } on MissingPluginException {
      return;
    } on PlatformException {
      return;
    }
  }

  Future<UpdateOffer?> _offer(String method) async {
    try {
      final raw = await _channel.invokeMethod<Object?>(method);
      if (raw is! Map) return null;
      return UpdateOffer.fromMap(raw.cast<Object?, Object?>());
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }
}

class AppUpdateController extends ChangeNotifier {
  AppUpdateController({required this.platform});

  final AppUpdatePlatform platform;
  bool ready = false;
  String? version;
  int? buildNumber;
  var _closed = false;

  Future<void> refresh() async {
    await platform.ensureDaily();
    final offer = await platform.check();
    _apply(offer);
  }

  Future<void> install() => platform.install();

  void _apply(UpdateOffer? offer) {
    ready = offer?.ready == true;
    version = offer?.version;
    buildNumber = offer?.buildNumber;
    if (!_closed) notifyListeners();
  }

  @override
  void dispose() {
    _closed = true;
    super.dispose();
  }
}

class UpdateScope extends InheritedWidget {
  const UpdateScope({super.key, required this.controller, required super.child});

  final AppUpdateController? controller;

  static AppUpdateController? maybeOf(BuildContext context) {
    return context.dependOnInheritedWidgetOfExactType<UpdateScope>()?.controller;
  }

  @override
  bool updateShouldNotify(UpdateScope oldWidget) => controller != oldWidget.controller;
}

/// Banner shown once a newer APK has been downloaded and its sha256 matches.
class UpdateHost extends StatefulWidget {
  const UpdateHost({super.key, required this.child});

  final Widget child;

  @override
  State<UpdateHost> createState() => _UpdateHostState();
}

class _UpdateHostState extends State<UpdateHost> with WidgetsBindingObserver {
  AppUpdateController? _controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final next = UpdateScope.maybeOf(context);
    if (!identical(next, _controller)) {
      _controller?.removeListener(_onUpdate);
      _controller = next;
      _controller?.addListener(_onUpdate);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller?.removeListener(_onUpdate);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_refresh());
  }

  void _onUpdate() {
    if (mounted) setState(() {});
  }

  Future<void> _refresh() async {
    final update = _controller;
    if (!mounted || update == null) return;
    await update.refresh();
  }

  @override
  Widget build(BuildContext context) {
    final update = _controller;
    if (update == null || !update.ready) return widget.child;
    final scheme = Theme.of(context).colorScheme;
    return Column(
      children: [
        Material(
          color: scheme.primary,
          child: SafeArea(
            bottom: false,
            child: ListTile(
              key: const Key('update-ready'),
              title: Text(
                'Update ready',
                style: TextStyle(color: scheme.onPrimary, fontWeight: FontWeight.w600),
              ),
              trailing: Icon(Icons.install_mobile, color: scheme.onPrimary),
              onTap: () => update.install(),
            ),
          ),
        ),
        Expanded(
          child: MediaQuery.removePadding(
            context: context,
            removeTop: true,
            child: widget.child,
          ),
        ),
      ],
    );
  }
}
