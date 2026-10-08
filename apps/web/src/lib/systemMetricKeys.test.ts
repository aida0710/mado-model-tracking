import { describe, expect, it } from 'vitest';
import {
  chartValueUnit,
  classifySystemMetricKey,
  groupSystemMetricKeys,
  isSystemMetricKey,
  systemMetricValueScale,
} from './systemMetricKeys';

describe('classifySystemMetricKey', () => {
  it.each([
    ['system.cpu.percent', 'cpu', null, 'percent'],
    ['system/cpu_utilization_percentage', 'cpu', null, 'percent'],
    ['system.memory.used_bytes', 'memory', null, 'bytes'],
    ['system/system_memory_usage_megabytes', 'memory', null, 'bytes'],
    ['system.process.memory_bytes', 'memory', null, 'bytes'],
    ['system.disk.read_bytes_per_second', 'disk', null, 'bytes_per_second'],
    ['system/disk_available_megabytes', 'disk', null, 'bytes'],
    ['system.network.sent_bytes_per_second', 'network', null, 'bytes_per_second'],
    ['system/network_receive_megabytes', 'network', null, 'bytes_total'],
    ['system.gpu.1.utilization_percent', 'gpu', 1, 'percent'],
    ['system/gpu_1_utilization_percentage', 'gpu', 1, 'percent'],
    ['system.gpu.12.memory_total_bytes', 'gpu', 12, 'bytes'],
    ['system/gpu_12_memory_usage_megabytes', 'gpu', 12, 'bytes'],
    ['system.gpu.0.temperature_celsius', 'gpu', 0, 'celsius'],
    ['system/gpu_0_power_usage_watts', 'gpu', 0, 'watts'],
  ])('puts %s under %s GPU %s in %s', (key, category, gpuIndex, unit) => {
    expect(classifySystemMetricKey(key)).toMatchObject({ category, gpuIndex, unit });
  });

  it('ignores metrics that are not system metrics', () => {
    expect(classifySystemMetricKey('train/loss')).toBeNull();
    expect(isSystemMetricKey('systemic_error')).toBe(false);
  });
});

describe('systemMetricValueScale', () => {
  it('converts MLflow megabytes to bytes and leaves other values as recorded', () => {
    expect(systemMetricValueScale('system/system_memory_usage_megabytes')).toBe(1_000_000);
    expect(systemMetricValueScale('system/gpu_0_memory_usage_megabytes')).toBe(1_000_000);
    expect(systemMetricValueScale('system.memory.used_bytes')).toBe(1);
    expect(systemMetricValueScale('system/cpu_utilization_percentage')).toBe(1);
    expect(systemMetricValueScale('loss')).toBe(1);
  });
});

describe('groupSystemMetricKeys', () => {
  it('gives Runs with Mado and MLflow names the same panels in the same order', () => {
    const mado = groupSystemMetricKeys([
      'system.gpu.1.utilization_percent',
      'system.gpu.0.utilization_percent',
      'system.memory.used_bytes',
      'system.cpu.percent',
    ]);
    const mlflow = groupSystemMetricKeys([
      'system/gpu_0_utilization_percentage',
      'system/cpu_utilization_percentage',
      'system/gpu_1_utilization_percentage',
      'system/system_memory_usage_megabytes',
    ]);
    const ids = ['cpu.percent', 'memory.bytes', 'gpu.0.percent', 'gpu.1.percent'];
    expect(mado.map((group) => group.id)).toEqual(ids);
    expect(mlflow.map((group) => group.id)).toEqual(ids);
  });

  it('draws both names of one quantity in one panel', () => {
    const [memory] = groupSystemMetricKeys([
      'system.memory.used_bytes',
      'system/system_memory_usage_megabytes',
    ]);
    expect(memory?.metricKeys).toEqual([
      'system.memory.used_bytes',
      'system/system_memory_usage_megabytes',
    ]);
  });

  it('keeps per-second and cumulative network traffic apart', () => {
    const groups = groupSystemMetricKeys([
      'system.network.received_bytes_per_second',
      'system/network_receive_megabytes',
    ]);
    expect(groups.map((group) => group.id)).toEqual([
      'network.bytes_per_second',
      'network.bytes_total',
    ]);
  });

  it('gives an unknown system name a panel of its own', () => {
    const groups = groupSystemMetricKeys(['system/custom_counter', 'system.cpu.percent']);
    expect(groups.map((group) => [group.id, group.category])).toEqual([
      ['cpu.percent', 'cpu'],
      ['other.system/custom_counter', 'other'],
    ]);
  });
});

describe('chartValueUnit', () => {
  it('bytesの系統だけの図はbytes、bytes/秒だけの図はbytes_per_secondの目盛りにする', () => {
    expect(chartValueUnit(['system.memory.used_bytes', 'system.process.rss_bytes'])).toBe('bytes');
    expect(chartValueUnit(['system/system_memory_usage_megabytes'])).toBe('bytes');
    expect(chartValueUnit(['system.disk.read_bytes_per_second'])).toBe('bytes_per_second');
  });

  it('単位の違うmetricや学習のmetricが混ざれば数値のまま出す', () => {
    expect(chartValueUnit(['system.memory.used_bytes', 'system.disk.read_bytes_per_second'])).toBe('number');
    expect(chartValueUnit(['train.loss'])).toBe('number');
  });
});
