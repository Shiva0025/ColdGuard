import type { DeviceStatus, IncidentType } from './wire.js';

export const STATUS_ORDER: Record<DeviceStatus, number> = { critical: 0, offline: 1, warning: 2, healthy: 3 };

export const INCIDENT_LABEL: Record<IncidentType, string> = {
  temp_high: 'Temperature above range',
  temp_low: 'Temperature below range',
  rapid_drift: 'Rapid temperature drift',
  sensor_offline: 'Sensor offline',
  low_battery: 'Low logger battery',
  exposure_budget: 'Heat-exposure budget exhausted',
};

export const COMMAND_LABEL = {
  close_door: 'Close refrigerated compartment',
  restore_cooling: 'Restore primary cooling',
  backup_cooling: 'Activate backup cooling',
} as const;
