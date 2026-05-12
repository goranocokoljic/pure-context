export default class AppConfig {
  readonly version = '1.0.0';
  debug = false;
  maxConnections = 10;

  validate(): boolean {
    return this.maxConnections > 0;
  }
}
