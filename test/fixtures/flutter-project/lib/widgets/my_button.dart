import 'package:flutter/material.dart';

/// A reusable button widget.
class MyButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;

  const MyButton({super.key, required this.label, this.onPressed});

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      onPressed: onPressed,
      child: Text(label),
    );
  }
}

/// A styled card widget.
@immutable
class AppCard extends StatelessWidget {
  final Widget child;
  final double elevation;

  const AppCard({super.key, required this.child, this.elevation = 2.0});

  @override
  Widget build(BuildContext context) {
    return Card(elevation: elevation, child: child);
  }
}
