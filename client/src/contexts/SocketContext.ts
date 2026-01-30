import { createContext, useContext } from 'react'
import { Socket } from 'socket.io-client'

export interface ConnectionStatus {
  connected: boolean
  reconnecting: boolean
  reconnectAttempt: number
  error: string | null
}

export const SocketContext = createContext<Socket | null>(null)
export const ConnectionStatusContext = createContext<ConnectionStatus>({
  connected: false,
  reconnecting: false,
  reconnectAttempt: 0,
  error: null,
})

export function useSocket() {
  return useContext(SocketContext)
}

export function useConnectionStatus() {
  return useContext(ConnectionStatusContext)
}
