<script setup lang="ts">
import { computed } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { useAutomations } from '@/stores/automations'
import { useDevices } from '@/stores/devices'

const rules = useAutomations()
const devices = useDevices()

const sources = computed(() => devices.nodes.map((n) => ({ id: n.id, label: n.label })))
</script>

<template>
  <div>
    <div class="bn-subhead">
      rules
      <span class="bn-grow"></span>
      <HbButton variant="danger" size="sm" :disabled="!sources.length" @click="rules.addBlank()">
        <template #icon><HbIcon name="plus" /></template>
        new rule
      </HbButton>
    </div>

    <p v-if="!sources.length" class="bn-note" style="margin-top: 0">
      connect something first. a rule needs a device to watch and a device to act on.
    </p>

    <div v-for="rule in rules.rules" :key="rule.id" style="margin-bottom: 18px">
      <div class="bn-flow">
        <div class="bn-node is-trigger">
          <div class="bn-nh"><HbIcon name="bolt" :size="9" />when</div>
          <div class="bn-nb">
            <b>{{ rule.trigger.kind }}</b>
            <div>{{ rule.trigger.detail }}</div>
          </div>
        </div>
        <div class="bn-arrow"><HbIcon name="arrow-right" :size="22" /></div>
        <div class="bn-node is-condition">
          <div class="bn-nh"><HbIcon name="filter" :size="9" />if</div>
          <div class="bn-nb">
            <b>{{ rule.condition.kind }}</b>
            <div>{{ rule.condition.detail }}</div>
          </div>
        </div>
        <div class="bn-arrow"><HbIcon name="arrow-right" :size="22" /></div>
        <div class="bn-node is-action">
          <div class="bn-nh"><HbIcon name="play" :size="9" />do</div>
          <div class="bn-nb">
            <b>{{ rule.action.kind }}</b>
            <div>{{ rule.action.detail }}</div>
          </div>
        </div>
      </div>

      <div class="bn-acts" style="margin-top: 8px">
        <button
          type="button"
          class="bn-toggle"
          :class="{ 'is-on': rule.enabled }"
          @click="rules.toggle(rule.id)"
        >
          <span class="bn-sw"><i></i></span>{{ rule.enabled ? 'armed' : 'off' }}
        </button>
        <span class="bn-chipx">fired {{ rule.fired }}</span>
        <span v-if="rule.lastError" class="bn-trk">{{ rule.lastError }}</span>
        <button type="button" class="bn-tinyact" @click="rules.remove(rule.id)">delete</button>
      </div>
    </div>

    <p v-if="!rules.rules.length && sources.length" class="bn-note" style="margin-top: 0">
      nothing wired up yet. a rule watches one device stream and acts on another, so a
      frame seen on a radio can move a servo on a board, or a word heard through
      transcription can start a recording.
    </p>
  </div>
</template>
