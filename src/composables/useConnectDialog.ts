import { ref } from 'vue'

const isOpen = ref(false)

/**
 * The connect dialog is opened from several places (the header, the empty
 * bench, a faceplate) so its open state lives outside the component.
 */
export function useConnectDialog() {
  return {
    isOpen,
    open: () => {
      isOpen.value = true
    },
    close: () => {
      isOpen.value = false
    },
  }
}
