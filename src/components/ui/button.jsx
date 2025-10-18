import React from 'react'

export function Button({ children, className = '', variant = 'default', ...props }) {
  const variants = {
    default: 'bg-gray-900 text-white hover:bg-gray-800',
    secondary: 'bg-white text-gray-900 border hover:bg-gray-50',
  }
  return (
    <button
      className={`inline-flex items-center justify-center px-3 py-2 rounded-md text-sm font-medium transition ${variants[variant]||variants.default} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
