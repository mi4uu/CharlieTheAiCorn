/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { SpeechToTextConfig } from '@/common/types/provider/speech';
import AionSelect from '@/renderer/components/base/AionSelect';
import { SPEECH_TO_TEXT_CONFIG_CHANGED_EVENT } from '@/renderer/services/SpeechToTextService';
import { getClientBusinessSetting, setClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import { getModelStreamCapability } from '@/renderer/services/speech/speechStreamPolicy';
import { AutoComplete, Button, Divider, Form, Input, Switch } from '@arco-design/web-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SpeechTestPanel from './SpeechTestPanel';
import {
  DEEPGRAM_SPEECH_MODEL_PRESETS,
  DEFAULT_SPEECH_TO_TEXT_CONFIG,
  OPENAI_SPEECH_MODEL_PRESETS,
  SPEECH_LANGUAGE_OPTIONS,
  applySpeechSource,
  buildModelOptions,
  deriveSpeechSource,
  getAutoTranscriptionPrompt,
  isValidHttpUrl,
  migrateSpeechLanguage,
  normalizeSpeechToTextConfig,
  fromStoredSpeechConfig,
  rankCustomSpeechModels,
  toStoredSpeechConfig,
  type SpeechSource,
} from './speechSettingsUtils';

const MODEL_FETCH_DEBOUNCE_MS = 600;

type OpenAIField = keyof NonNullable<SpeechToTextConfig['openai']>;
type DeepgramField = keyof NonNullable<SpeechToTextConfig['deepgram']>;

const FieldLabel: React.FC<{ labelKey: string; requirement: 'required' | 'optional' }> = ({
  labelKey,
  requirement,
}) => {
  const { t } = useTranslation();
  return (
    <span className='inline-flex items-center gap-6px'>
      <span>{t(labelKey)}</span>
      <span aria-hidden='true' className='text-12px text-t-tertiary'>
        ({t(requirement === 'required' ? 'settings.speechToTextRequired' : 'settings.speechToTextOptional')})
      </span>
    </span>
  );
};

const VoiceInputSection: React.FC = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<SpeechToTextConfig>(DEFAULT_SPEECH_TO_TEXT_CONFIG);
  // Source is UI state, only initialized from the stored config. A purely
  // derived source would snap "custom" back to "openai" while base_url is
  // still empty, making custom mode unreachable for fresh users.
  const [source, setSource] = useState<SpeechSource>('openai');
  const lastCustomBaseUrlRef = useRef('');

  useEffect(() => {
    let cancelled = false;

    const loadSpeechConfig = async () => {
      try {
        const stored = await getClientBusinessSetting('tools.speechToText');
        if (cancelled) {
          return;
        }
        const normalized = fromStoredSpeechConfig(migrateSpeechLanguage(normalizeSpeechToTextConfig(stored)));
        setConfig(normalized);
        setSource(deriveSpeechSource(normalized));
        if (deriveSpeechSource(normalized) === 'custom') {
          lastCustomBaseUrlRef.current = normalized.openai?.base_url ?? '';
        }
      } catch (error) {
        console.error('Failed to load speech-to-text config:', error);
      }
    };

    void loadSpeechConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  const updateConfig = useCallback((updater: (current: SpeechToTextConfig) => SpeechToTextConfig) => {
    setConfig((current) => {
      const next = normalizeSpeechToTextConfig(updater(current));
      void setClientBusinessSetting('tools.speechToText', toStoredSpeechConfig(next)).catch((error) => {
        console.error('Failed to save speech-to-text config:', error);
      });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(SPEECH_TO_TEXT_CONFIG_CHANGED_EVENT));
      }
      return next;
    });
  }, []);

  const handleSourceChange = useCallback(
    (value: string) => {
      setSource(value as SpeechSource);
      updateConfig((current) => {
        if (deriveSpeechSource(current) === 'custom') {
          lastCustomBaseUrlRef.current = current.openai?.base_url ?? '';
        }
        return applySpeechSource(current, value as SpeechSource, lastCustomBaseUrlRef.current);
      });
    },
    [updateConfig]
  );

  const handleOpenAIChange = useCallback(
    (field: OpenAIField, value: string) => {
      updateConfig(
        (current) =>
          ({
            ...current,
            openai: { ...DEFAULT_SPEECH_TO_TEXT_CONFIG.openai, ...current.openai, [field]: value },
          }) as SpeechToTextConfig
      );
    },
    [updateConfig]
  );

  const handleDeepgramChange = useCallback(
    (field: DeepgramField, value: string | boolean) => {
      updateConfig(
        (current) =>
          ({
            ...current,
            deepgram: { ...DEFAULT_SPEECH_TO_TEXT_CONFIG.deepgram, ...current.deepgram, [field]: value },
          }) as SpeechToTextConfig
      );
    },
    [updateConfig]
  );

  const isDeepgram = source === 'deepgram';
  const isCustom = source === 'custom';
  const activeLanguage = (isDeepgram ? config.deepgram?.language : config.openai?.language) ?? '';
  const activeModel = (isDeepgram ? config.deepgram?.model : config.openai?.model) ?? '';
  const activeApiKey = (isDeepgram ? config.deepgram?.api_key : config.openai?.api_key) ?? '';
  const modelPresets = isDeepgram ? DEEPGRAM_SPEECH_MODEL_PRESETS : OPENAI_SPEECH_MODEL_PRESETS;
  const customBaseUrl = config.openai?.base_url ?? '';
  const isBaseUrlInvalid = isCustom && customBaseUrl.trim() !== '' && !isValidHttpUrl(customBaseUrl);
  const customApiKey = config.openai?.api_key ?? '';

  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [modelsRefresh, setModelsRefresh] = useState(0);

  useEffect(() => {
    if (!isCustom || !isValidHttpUrl(customBaseUrl)) {
      setRemoteModels([]);
      setModelsError('');
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setModelsLoading(true);
      // The backend validator requires a non-empty key; local servers ignore it.
      ipcBridge.mode.fetchModelList
        .invoke({ platform: 'custom', base_url: customBaseUrl.trim(), api_key: customApiKey.trim() || 'none' })
        .then((res) => {
          if (cancelled) return;
          const ids = res.models.map((m) => (typeof m === 'string' ? m : m.id));
          setRemoteModels(rankCustomSpeechModels(ids));
          setModelsError('');
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setRemoteModels([]);
          setModelsError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!cancelled) setModelsLoading(false);
        });
    }, MODEL_FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isCustom, customBaseUrl, customApiKey, modelsRefresh]);

  const handleModelChange = useCallback(
    (value: string) => {
      if (isDeepgram) {
        handleDeepgramChange('model', value);
      } else {
        handleOpenAIChange('model', value);
      }
    },
    [handleDeepgramChange, handleOpenAIChange, isDeepgram]
  );

  const handleLanguageChange = useCallback(
    (value: string) => {
      if (isDeepgram) {
        handleDeepgramChange('language', value);
        return;
      }
      // Whisper-family `zh` is script-ambiguous: pair the language with a
      // same-script prompt (undefined clears it for non-Chinese languages).
      updateConfig(
        (current) =>
          ({
            ...current,
            openai: {
              ...DEFAULT_SPEECH_TO_TEXT_CONFIG.openai,
              ...current.openai,
              language: value,
              prompt: getAutoTranscriptionPrompt(value),
            },
          }) as SpeechToTextConfig
      );
    },
    [handleDeepgramChange, isDeepgram, updateConfig]
  );

  const handleApiKeyChange = useCallback(
    (value: string) => {
      if (isDeepgram) {
        handleDeepgramChange('api_key', value);
      } else {
        handleOpenAIChange('api_key', value);
      }
    },
    [handleDeepgramChange, handleOpenAIChange, isDeepgram]
  );

  return (
    <div className='px-[12px] md:px-[32px] py-[24px] bg-2 rd-12px md:rd-16px border border-border-2'>
      <div className='flex items-center justify-between gap-12px mb-8px'>
        <div className='flex flex-col gap-4px'>
          <span className='text-14px text-t-primary'>{t('settings.speechToText')}</span>
          <span className='text-13px text-t-secondary'>{t('settings.speechToTextDescription')}</span>
        </div>
        <Switch
          checked={config.enabled}
          onChange={(checked) => updateConfig((current) => ({ ...current, enabled: checked }))}
        />
      </div>

      {config.enabled && (
        <>
          <Divider className='mt-0px mb-20px' />

          <Form layout='horizontal' labelAlign='left' className='space-y-12px'>
            <Form.Item label={t('settings.speechToTextSource')}>
              <AionSelect value={source} onChange={handleSourceChange}>
                <AionSelect.Option value='openai'>{t('settings.speechToTextSourceOpenAI')}</AionSelect.Option>
                <AionSelect.Option value='deepgram'>{t('settings.speechToTextSourceDeepgram')}</AionSelect.Option>
                <AionSelect.Option value='custom'>{t('settings.speechToTextSourceCustom')}</AionSelect.Option>
              </AionSelect>
            </Form.Item>

            {isCustom && (
              <Form.Item
                label={<FieldLabel labelKey='settings.speechToTextBaseUrl' requirement='required' />}
                validateStatus={isBaseUrlInvalid ? 'error' : undefined}
                help={isBaseUrlInvalid ? t('settings.speechToTextBaseUrlInvalid') : undefined}
              >
                <Input
                  value={customBaseUrl}
                  placeholder={t('settings.speechToTextBaseUrlPlaceholder')}
                  onChange={(value) => handleOpenAIChange('base_url', value)}
                />
              </Form.Item>
            )}

            <Form.Item
              label={
                <FieldLabel labelKey='settings.speechToTextApiKey' requirement={isCustom ? 'optional' : 'required'} />
              }
            >
              <Input.Password value={activeApiKey} visibilityToggle onChange={handleApiKeyChange} />
            </Form.Item>

            {isCustom ? (
              <Form.Item
                label={t('settings.speechToTextModel')}
                validateStatus={modelsError ? 'warning' : undefined}
                help={modelsError ? `${t('settings.speechToTextModelListFailed')}: ${modelsError}` : undefined}
              >
                <div className='flex items-center gap-8px'>
                  <AutoComplete
                    className='flex-1'
                    value={activeModel}
                    data={remoteModels}
                    onChange={(value) => handleModelChange(String(value ?? ''))}
                    placeholder={t('settings.speechToTextModelPlaceholder')}
                    triggerElement={<Input allowClear />}
                  />
                  <Button
                    loading={modelsLoading}
                    disabled={!isValidHttpUrl(customBaseUrl)}
                    onClick={() => setModelsRefresh((n) => n + 1)}
                  >
                    {t('settings.speechToTextModelRefresh')}
                  </Button>
                </div>
              </Form.Item>
            ) : (
              <Form.Item label={t('settings.speechToTextModel')}>
                <AionSelect value={activeModel || undefined} onChange={handleModelChange}>
                  {buildModelOptions(modelPresets, activeModel).map((model) => {
                    const capability = getModelStreamCapability(source, model);
                    const badgeText =
                      capability === 'supported'
                        ? t('settings.speechToTextStreamingBadge')
                        : capability === 'unsupported'
                          ? t('settings.speechToTextWholeBadge')
                          : null;
                    return (
                      <AionSelect.Option key={model} value={model}>
                        {model}
                        {badgeText !== null && <span className='text-12px text-t-tertiary ms-8px'>{badgeText}</span>}
                      </AionSelect.Option>
                    );
                  })}
                </AionSelect>
              </Form.Item>
            )}

            <Form.Item label={t('settings.speechToTextLanguage')}>
              <AionSelect value={activeLanguage} onChange={handleLanguageChange}>
                {SPEECH_LANGUAGE_OPTIONS.map((option) => (
                  <AionSelect.Option key={option.value || 'auto'} value={option.value}>
                    {option.label ?? t('settings.speechToTextLanguageAuto')}
                  </AionSelect.Option>
                ))}
              </AionSelect>
            </Form.Item>
          </Form>
          <SpeechTestPanel config={config} source={source} />
        </>
      )}
    </div>
  );
};

export default VoiceInputSection;
