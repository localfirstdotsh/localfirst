import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiContractError, ApiRequestError, ApiUnavailableError, listHardware, listModels } from '../../lib/api';
import { ModelsCatalog } from './ModelsCatalog';
import { HardwareCatalog } from './HardwareCatalog';

vi.mock('../../lib/api', async (original) => ({
  ...await original<typeof import('../../lib/api')>(), listModels: vi.fn(), listHardware: vi.fn(),
}));
const models = vi.mocked(listModels);
const hardware = vi.mocked(listHardware);

beforeEach(() => { models.mockReset().mockResolvedValue([]); hardware.mockReset().mockResolvedValue([]); });

describe.each([
  { name: 'models', render: ModelsCatalog, empty: 'No models yet' },
  { name: 'hardware', render: HardwareCatalog, empty: 'No hardware yet' },
])('$name discovery', ({ name, render, empty }) => {
  it('shows successful empty data as neutral feedback with a project navigation action', async () => {
    const out = renderToStaticMarkup(await render());
    expect(out).toContain(empty);
    expect(out).toContain('role="status"');
    expect(out).not.toContain('role="alert"');
    expect(out).toContain('href="/projects"');
    expect(out).toContain('Explore projects');
    expect(out).not.toContain('Clear filters');
  });

  it.each([
    new ApiUnavailableError('Network unavailable', 'req-unavailable'),
    new ApiContractError('Invalid response'),
    new ApiRequestError('Rate limited', 429, 'RATE_LIMITED', 'req-limited'),
    new Error('Network failed'),
  ])('keeps failures distinct and provides a retry for the original page: %s', async (error) => {
    const read = name === 'models' ? models : hardware;
    read.mockRejectedValue(error);
    const out = renderToStaticMarkup(await render());
    expect(out).toContain('could not be loaded');
    expect(out).toContain('role="alert"');
    expect(out).not.toContain(empty);
    expect(out).not.toContain('empty-state');
    expect(out).toContain(`href="/${name}"`);
    expect(out).toContain('Try again');
    if (error instanceof ApiUnavailableError || error instanceof ApiRequestError) expect(out).toContain(error.requestId!);
  });
});

it('retains populated model metadata, project navigation, and contextual disclosures', async () => {
  models.mockResolvedValue([{
    model_reference_id: 'model-1', key: 'reference-model', display_name: 'Reference model', family: null,
    source_url: 'https://example.org/model', license_state: 'unknown', license_id: null, project_count: 2,
  }]);
  const out = renderToStaticMarkup(await ModelsCatalog());
  expect(out).toContain('Reference model');
  expect(out).toContain('Family: Not supplied');
  expect(out).toContain('href="/projects?model=reference-model"');
  expect(out).toContain('<summary>About these model references</summary>');
  expect(out).toContain('No weights are hosted here');
  expect(out).not.toContain('No models yet');
});

it('retains populated hardware metadata, honest unknowns, and contextual disclosures', async () => {
  hardware.mockResolvedValue([{
    hardware_descriptor_id: 'device-1', key: 'reference-device', display_name: 'Reference device', platform: null,
    cpu_architecture: null, accelerator: null, memory_bytes: null, vram_bytes: null, unified_memory: null,
    docs_url: null, project_count: 1,
  }]);
  const out = renderToStaticMarkup(await HardwareCatalog());
  expect(out).toContain('Reference device');
  expect(out).toContain('Memory not supplied');
  expect(out).not.toContain('0 GiB');
  expect(out).toContain('href="/projects?hardware=reference-device"');
  expect(out).toContain('<summary>About this hardware information</summary>');
  expect(out).toContain('not measured');
  expect(out).not.toContain('No hardware yet');
});
