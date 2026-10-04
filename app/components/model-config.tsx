import { ServiceProvider } from "@/app/constant";
import { useState, type ComponentProps, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ModalConfigValidator, ModelConfig } from "../store";

import Locale from "../locales";
import { InputRange } from "./input-range";
import { ListItem, Select } from "./ui-lib";
import { useAllModels } from "../utils/hooks";
import { groupBy } from "lodash-es";
import styles from "./model-config.module.scss";
import { getModelProvider } from "../utils/model";

function DeferredModelSelect({
  models,
  value,
  automatic = false,
  grouped = false,
  ...props
}: Omit<ComponentProps<typeof Select>, "children" | "value" | "className"> & {
  models: ReturnType<typeof useAllModels>;
  value: string;
  automatic?: boolean;
  grouped?: boolean;
}) {
  const [ready, setReady] = useState(false);
  const currentModel = models.find(
    (model) => `${model.name}@${model.provider.providerName}` === value,
  );

  function prepareOptions() {
    if (ready) return;
    // Native pickers must see the complete list before the event's default action.
    flushSync(() => setReady(true));
  }

  function modelLabel(model: (typeof models)[number]) {
    const name = model.displayName ?? model.name;
    return grouped ? name : `${name}(${model.provider.providerName})`;
  }

  function renderOption(model: (typeof models)[number]) {
    const modelValue = `${model.name}@${model.provider.providerName}`;
    return (
      <option value={modelValue} key={modelValue}>
        {modelLabel(model)}
      </option>
    );
  }

  let options: ReactNode = null;
  if (ready) {
    const availableModels = models.filter((model) => model.available);
    if (grouped) {
      const groups = groupBy(availableModels, "provider.providerName");
      options = Object.entries(groups).map(([providerName, providerModels]) => (
        <optgroup label={providerName} key={providerName}>
          {providerModels.map(renderOption)}
        </optgroup>
      ));
    } else {
      options = availableModels.map(renderOption);
    }
  }

  return (
    <Select
      {...props}
      className={styles["select-model"]}
      value={value}
      onPointerDown={prepareOptions}
      onFocus={() => setReady(true)}
      onKeyDown={prepareOptions}
    >
      {automatic && <option value="@">{Locale.Settings.AutomaticModel}</option>}
      {value !== "@" && (!ready || !currentModel?.available) && (
        <option value={value} disabled={!currentModel?.available}>
          {currentModel ? modelLabel(currentModel) : value}
        </option>
      )}
      {options}
    </Select>
  );
}

export function ModelConfigList(props: {
  modelConfig: ModelConfig;
  updateConfig: (updater: (config: ModelConfig) => void) => void;
}) {
  const allModels = useAllModels();
  const value = `${props.modelConfig.model}@${props.modelConfig?.providerName}`;

  const getModelValue = (model?: string, providerName?: string) =>
    model ? `${model}@${providerName ?? ""}` : "@";

  const compressModelValue = getModelValue(
    props.modelConfig.compressModel,
    props.modelConfig.compressProviderName,
  );
  const titleModelValue = getModelValue(
    props.modelConfig.titleModel,
    props.modelConfig.titleProviderName,
  );
  const memoryModelValue = getModelValue(
    props.modelConfig.memoryModel,
    props.modelConfig.memoryProviderName,
  );

  return (
    <>
      <ListItem title={Locale.Settings.Model}>
        <DeferredModelSelect
          models={allModels}
          grouped
          aria-label={Locale.Settings.Model}
          value={value}
          align="left"
          onChange={(e) => {
            const [model, providerName] = getModelProvider(e.currentTarget.value);
            props.updateConfig((config) => {
              config.model = ModalConfigValidator.model(model);
              config.providerName = providerName as ServiceProvider;
            });
          }}
        />
      </ListItem>
      <ListItem
        title={Locale.Settings.Temperature.Title}
        subTitle={Locale.Settings.Temperature.SubTitle}
      >
        <InputRange
          aria={Locale.Settings.Temperature.Title}
          value={props.modelConfig.temperature?.toFixed(1)}
          min="0"
          max="1" // lets limit it to 0-1
          step="0.1"
          onChange={(e) => {
            props.updateConfig(
              (config) =>
                (config.temperature = ModalConfigValidator.temperature(
                  e.currentTarget.valueAsNumber,
                )),
            );
          }}
        ></InputRange>
      </ListItem>
      <ListItem title={Locale.Settings.TopP.Title} subTitle={Locale.Settings.TopP.SubTitle}>
        <InputRange
          aria={Locale.Settings.TopP.Title}
          value={(props.modelConfig.top_p ?? 1).toFixed(1)}
          min="0"
          max="1"
          step="0.1"
          onChange={(e) => {
            props.updateConfig(
              (config) =>
                (config.top_p = ModalConfigValidator.top_p(e.currentTarget.valueAsNumber)),
            );
          }}
        ></InputRange>
      </ListItem>
      <ListItem
        title={Locale.Settings.MaxTokens.Title}
        subTitle={Locale.Settings.MaxTokens.SubTitle}
      >
        <input
          aria-label={Locale.Settings.MaxTokens.Title}
          type="number"
          min={1024}
          max={512000}
          value={props.modelConfig.max_tokens}
          onChange={(e) =>
            props.updateConfig(
              (config) =>
                (config.max_tokens = ModalConfigValidator.max_tokens(
                  e.currentTarget.valueAsNumber,
                )),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.ContextWindow.Title}
        subTitle={Locale.Settings.ContextWindow.SubTitle}
      >
        <input
          aria-label={Locale.Settings.ContextWindow.Title}
          type="number"
          min={1024}
          max={2_000_000}
          value={props.modelConfig.contextWindowTokens}
          onChange={(e) =>
            props.updateConfig(
              (config) =>
                (config.contextWindowTokens = ModalConfigValidator.contextWindowTokens(
                  e.currentTarget.valueAsNumber,
                )),
            )
          }
        ></input>
      </ListItem>

      {props.modelConfig?.providerName == ServiceProvider.Google ? null : (
        <>
          <ListItem
            title={Locale.Settings.PresencePenalty.Title}
            subTitle={Locale.Settings.PresencePenalty.SubTitle}
          >
            <InputRange
              aria={Locale.Settings.PresencePenalty.Title}
              value={props.modelConfig.presence_penalty?.toFixed(1)}
              min="-2"
              max="2"
              step="0.1"
              onChange={(e) => {
                props.updateConfig(
                  (config) =>
                    (config.presence_penalty = ModalConfigValidator.presence_penalty(
                      e.currentTarget.valueAsNumber,
                    )),
                );
              }}
            ></InputRange>
          </ListItem>

          <ListItem
            title={Locale.Settings.FrequencyPenalty.Title}
            subTitle={Locale.Settings.FrequencyPenalty.SubTitle}
          >
            <InputRange
              aria={Locale.Settings.FrequencyPenalty.Title}
              value={props.modelConfig.frequency_penalty?.toFixed(1)}
              min="-2"
              max="2"
              step="0.1"
              onChange={(e) => {
                props.updateConfig(
                  (config) =>
                    (config.frequency_penalty = ModalConfigValidator.frequency_penalty(
                      e.currentTarget.valueAsNumber,
                    )),
                );
              }}
            ></InputRange>
          </ListItem>

          <ListItem
            title={Locale.Settings.InjectSystemPrompts.Title}
            subTitle={Locale.Settings.InjectSystemPrompts.SubTitle}
          >
            <input
              aria-label={Locale.Settings.InjectSystemPrompts.Title}
              type="checkbox"
              checked={props.modelConfig.enableInjectSystemPrompts}
              onChange={(e) =>
                props.updateConfig(
                  (config) => (config.enableInjectSystemPrompts = e.currentTarget.checked),
                )
              }
            ></input>
          </ListItem>

          <ListItem
            title={Locale.Settings.InputTemplate.Title}
            subTitle={Locale.Settings.InputTemplate.SubTitle}
          >
            <input
              aria-label={Locale.Settings.InputTemplate.Title}
              type="text"
              value={props.modelConfig.template}
              onChange={(e) =>
                props.updateConfig((config) => (config.template = e.currentTarget.value))
              }
            ></input>
          </ListItem>
        </>
      )}
      <ListItem
        title={Locale.Settings.HistoryCount.Title}
        subTitle={Locale.Settings.HistoryCount.SubTitle}
      >
        <InputRange
          aria={Locale.Settings.HistoryCount.Title}
          title={props.modelConfig.recentRawNodeCount.toString()}
          value={props.modelConfig.recentRawNodeCount}
          min="0"
          max="64"
          step="1"
          onChange={(e) =>
            props.updateConfig((config) => (config.recentRawNodeCount = e.target.valueAsNumber))
          }
        ></InputRange>
      </ListItem>

      <ListItem
        title={Locale.Settings.CompressThreshold.Title}
        subTitle={Locale.Settings.CompressThreshold.SubTitle}
      >
        <input
          aria-label={Locale.Settings.CompressThreshold.Title}
          type="number"
          min={500}
          max={4000}
          value={props.modelConfig.segmentTargetSourceTokens}
          onChange={(e) =>
            props.updateConfig(
              (config) => (config.segmentTargetSourceTokens = e.currentTarget.valueAsNumber),
            )
          }
        ></input>
      </ListItem>
      <ListItem title={Locale.Memory.Title} subTitle={Locale.Memory.Send}>
        <input
          aria-label={Locale.Memory.Title}
          type="checkbox"
          checked={props.modelConfig.enableConversationSummaries}
          onChange={(e) =>
            props.updateConfig(
              (config) => (config.enableConversationSummaries = e.currentTarget.checked),
            )
          }
        ></input>
      </ListItem>
      <ListItem
        title={Locale.Settings.CompressModel.Title}
        subTitle={Locale.Settings.CompressModel.SubTitle}
      >
        <DeferredModelSelect
          models={allModels}
          automatic
          aria-label={Locale.Settings.CompressModel.Title}
          value={compressModelValue}
          onChange={(e) => {
            const [model, providerName] = getModelProvider(e.currentTarget.value);
            props.updateConfig((config) => {
              config.compressModel = ModalConfigValidator.model(model);
              config.compressProviderName = providerName as ServiceProvider;
            });
          }}
        />
      </ListItem>
      <ListItem
        title={Locale.Settings.MemoryModel.Title}
        subTitle={Locale.Settings.MemoryModel.SubTitle}
      >
        <DeferredModelSelect
          models={allModels}
          automatic
          aria-label={Locale.Settings.MemoryModel.Title}
          value={memoryModelValue}
          onChange={(e) => {
            const [model, providerName] = getModelProvider(e.currentTarget.value);
            props.updateConfig((config) => {
              config.memoryModel = ModalConfigValidator.model(model);
              config.memoryProviderName = providerName as ServiceProvider;
            });
          }}
        />
      </ListItem>
      <ListItem
        title={Locale.Settings.TitleModel.Title}
        subTitle={Locale.Settings.TitleModel.SubTitle}
      >
        <DeferredModelSelect
          models={allModels}
          automatic
          aria-label={Locale.Settings.TitleModel.Title}
          value={titleModelValue}
          onChange={(e) => {
            const [model, providerName] = getModelProvider(e.currentTarget.value);
            props.updateConfig((config) => {
              config.titleModel = ModalConfigValidator.model(model);
              config.titleProviderName = providerName as ServiceProvider;
            });
          }}
        />
      </ListItem>
    </>
  );
}
