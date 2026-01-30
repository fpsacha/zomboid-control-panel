import { useEffect, useRef, useCallback } from 'react'

/**
 * Hook that provides a fetch function with automatic cancellation on unmount.
 * Uses AbortController to cancel pending requests when the component unmounts.
 */
export function useCancellableFetch() {
  const abortControllerRef = useRef<AbortController | null>(null)
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])
  
  /**
   * Fetch with automatic abort on unmount
   */
  const fetchWithCancel = useCallback(async <T>(
    url: string,
    options?: RequestInit
  ): Promise<T> => {
    // Cancel any previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    
    // Create new controller
    abortControllerRef.current = new AbortController()
    
    const response = await fetch(url, {
      ...options,
      signal: abortControllerRef.current.signal,
    })
    
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || `HTTP ${response.status}`)
    }
    
    return response.json()
  }, [])
  
  /**
   * Cancel the current pending request
   */
  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])
  
  /**
   * Check if the error is an abort error (should be ignored)
   */
  const isAbortError = useCallback((error: unknown): boolean => {
    return error instanceof DOMException && error.name === 'AbortError'
  }, [])
  
  return { fetchWithCancel, cancel, isAbortError }
}

/**
 * Hook for managing multiple concurrent cancellable requests by key.
 * Useful for pages that make multiple API calls that should be cancelled together.
 */
export function useCancellableRequests() {
  const controllersRef = useRef<Map<string, AbortController>>(new Map())
  
  // Cleanup all on unmount
  useEffect(() => {
    return () => {
      controllersRef.current.forEach(controller => controller.abort())
      controllersRef.current.clear()
    }
  }, [])
  
  /**
   * Get or create an AbortController for a specific key
   */
  const getSignal = useCallback((key: string): AbortSignal => {
    // Cancel existing request for this key
    const existing = controllersRef.current.get(key)
    if (existing) {
      existing.abort()
    }
    
    // Create new controller
    const controller = new AbortController()
    controllersRef.current.set(key, controller)
    return controller.signal
  }, [])
  
  /**
   * Cancel a specific request by key
   */
  const cancelRequest = useCallback((key: string) => {
    const controller = controllersRef.current.get(key)
    if (controller) {
      controller.abort()
      controllersRef.current.delete(key)
    }
  }, [])
  
  /**
   * Cancel all pending requests
   */
  const cancelAll = useCallback(() => {
    controllersRef.current.forEach(controller => controller.abort())
    controllersRef.current.clear()
  }, [])
  
  /**
   * Check if the error is an abort error
   */
  const isAbortError = useCallback((error: unknown): boolean => {
    return error instanceof DOMException && error.name === 'AbortError'
  }, [])
  
  return { getSignal, cancelRequest, cancelAll, isAbortError }
}
