<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstScope from '@/components/instruments/InstScope.vue'
import { TrunkFollower } from '@/core/scanner/p25/trunk'
import type { TrunkCall } from '@/core/scanner/p25/trunk'
import { DemoControlChannel } from '@/core/scanner/p25/demo'
import { allSystems } from '@/core/scanner/systems'
import type { RadioSystem } from '@/core/scanner/systems'
import { SERVICE_LABELS } from '@/core/scanner/conventional'
import { useDevices } from '@/stores/devices'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { formatClock, formatHz } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const stream = useDeviceStream(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isDemo = computed(() => (node.value ? isSimKind(node.value.kind) : false))

const systems = allSystems()
const systemId = ref(systems[0]?.id ?? '')
const siteIndex = ref(0)
const running = ref(false)
const calls = shallowRef<TrunkCall[]>([])
const identCount = ref(0)
const serviceFilter = ref<string>('all')

const system = computed<RadioSystem | undefined>(() => systems.find((s) => s.id === systemId.value))
const site = computed(() => system.value?.sites[siteIndex.value])
const controlHz = computed(() => site.value?.controlHz[0] ?? 0)

let follower: TrunkFollower | null = null
let demo: DemoControlChannel | null = null
let feedTimer: ReturnType<typeof setInterval> | null = null
let ageTimer: ReturnType<typeof setInterval> | null = null

const filtered = computed(() => {
  if (serviceFilter.value === 'all') return calls.value
  return calls.value.filter((c) => c.service === serviceFilter.value)
})

const active = computed(() => calls.value.filter((c) => c.endedAt === null).slice(0, 6))

async function start(): Promise<void> {
  const sys = system.value
  if (!sys || !controlHz.value) return

  follower = new TrunkFollower(sys, {
    onCall: () => {
      calls.value = follower ? [...follower.callLog] : []
    },
    onCallEnd: () => {
      calls.value = follower ? [...follower.callLog] : []
    },
    onStatus: () => undefined,
    onIdent: (n) => {
      identCount.value = n
    },
  })
  follower.setCenter(controlHz.value)

  await devices.configure(props.deviceId, { centerHz: controlHz.value })
  await devices.start(props.deviceId, isDemo.value ? 'iq' : 'spectrum')
  running.value = true

  if (isDemo.value) {
    // in demo the control channel is synthetic, so grants flow immediately.
    demo = new DemoControlChannel(sys)
    feedTimer = setInterval(() => {
      if (demo && follower) follower.feedTsbk(demo.next())
    }, 260)
  }
  ageTimer = setInterval(() => follower?.tick(), 1000)
}

async function stop(): Promise<void> {
  running.value = false
  if (feedTimer) clearInterval(feedTimer)
  if (ageTimer) clearInterval(ageTimer)
  feedTimer = ageTimer = null
  demo = null
  await devices.stop(props.deviceId).catch(() => undefined)
}

function follow(call: TrunkCall): void {
  if (!call.followable) return
  void devices.configure(props.deviceId, { centerHz: call.hz })
}

const SERVICES = ['all', 'fire', 'law', 'ems', 'interop']

onBeforeUnmount(() => {
  void stop()
})
</script>

<template>
  <div>
    <p class="bn-note" style="margin-top: 0">
      a trunked system moves each conversation across a pool of frequencies. the bench
      watches the control channel, reads which talkgroup moved where, and shows it live.
    </p>

    <div class="bn-knobs" style="margin-top: 0">
      <div class="bn-knob" style="min-width: 240px">
        <span class="bn-klabel">system</span>
        <select v-model="systemId" :disabled="running">
          <option v-for="s in systems" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </div>
      <div class="bn-knob" style="min-width: 200px" v-if="system && system.sites.length">
        <span class="bn-klabel">site</span>
        <select v-model.number="siteIndex" :disabled="running">
          <option v-for="(s, i) in system.sites" :key="s.id" :value="i">{{ s.name }}</option>
        </select>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton v-if="!running" variant="danger" size="sm" :disabled="!controlHz" @click="start">
          <template #icon><HbIcon name="tower-cell" /></template>
          watch control
        </HbButton>
        <HbButton v-else size="sm" @click="stop">
          <template #icon><HbIcon name="stop" /></template>
          stop
        </HbButton>
      </div>
    </div>

    <div v-if="system && !system.sites.length" class="bn-banner is-warn">
      <HbIcon name="warning" />
      <span>
        this system has no control channel frequency bundled yet. add one in the import
        step, or pick a system that has sites listed.
      </span>
    </div>

    <div class="bn-meta">
      <div>
        <div class="bn-k">control</div>
        <div class="bn-v is-pink">{{ formatHz(controlHz) }}</div>
      </div>
      <div>
        <div class="bn-k">identifiers</div>
        <div class="bn-v">{{ identCount }}</div>
      </div>
      <div>
        <div class="bn-k">active</div>
        <div class="bn-v">{{ active.length }}</div>
      </div>
      <div>
        <div class="bn-k">calls</div>
        <div class="bn-v">{{ calls.length }}</div>
      </div>
      <div v-if="system?.wacn">
        <div class="bn-k">wacn</div>
        <div class="bn-v">{{ system.wacn }}</div>
      </div>
    </div>

    <InstScope :bins="stream.fft.value" :height="110" ruled :demo="!running" />

    <div v-if="!isDemo && running" class="bn-banner is-warn" style="margin-top: 12px">
      <HbIcon name="warning" />
      <span>
        following a live trunk needs a c4fm control channel decoder this browser build
        does not have yet. the receiver is parked on the control channel and the spectrum
        is live. for full trunk following with voice, op25 and sdrtrunk are the tools.
        turn on demo mode to see the activity view work.
      </span>
    </div>

    <div class="bn-subhead" style="margin-top: 14px">
      talkgroup activity
      <span class="bn-grow"></span>
      <button
        v-for="s in SERVICES"
        :key="s"
        type="button"
        class="bn-tinyact"
        :class="{ 'is-on': serviceFilter === s }"
        @click="serviceFilter = s"
      >
        {{ s }}
      </button>
    </div>

    <div class="bn-list">
      <div
        v-for="c in filtered.slice(0, 60)"
        :key="c.id"
        class="bn-row"
        :class="{ 'is-alert': c.emergency }"
      >
        <span class="bn-a">{{ c.name }}</span>
        <span class="bn-b">
          {{ SERVICE_LABELS[c.service as keyof typeof SERVICE_LABELS] ?? c.service }}
          <template v-if="c.encrypted"> (encrypted)</template>
        </span>
        <span class="bn-c">{{ c.endedAt === null ? 'live' : formatClock(c.startedAt) }}</span>
        <div class="bn-decode">
          {{ formatHz(c.hz) }}<template v-if="c.source"> from unit {{ c.source }}</template>
          <button
            v-if="c.followable"
            type="button"
            class="bn-tinyact"
            style="margin-left: 8px"
            @click="follow(c)"
          >
            follow
          </button>
          <template v-else> outside the tuned window, metadata only</template>
        </div>
      </div>
      <div v-if="!filtered.length" class="bn-row">
        <span class="bn-b">
          {{ running ? 'control channel is quiet. a healthy decoder can still see zero calls when the system is idle.' : 'pick a system and press watch control.' }}
        </span>
      </div>
    </div>

    <p class="bn-note">
      encrypted talkgroups show as active but produce no audio, which is honest about what
      a scanner can and cannot hear. most arizona law tactical is encrypted; fire dispatch
      and the interop channels are usually in the clear.
    </p>
  </div>
</template>
