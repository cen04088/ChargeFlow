import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import aitDevtools from "@apps-in-toss/devtools/unplugin";

// 실기기 디버거(debugger-client)는 AIT_DEBUG_BUILD=1로 만든 디버그 빌드에만 들어간다.
// 일반 빌드에서는 __DEBUG_BUILD__가 false로 접혀 debugger-client 코드가 번들에서 빠진다.
// 서명 공개키는 `npx debugger relay-key --json` 출력을 AIT_RELAY_KEYS로 넘긴다(공개 데이터).
const debugBuild = process.env.AIT_DEBUG_BUILD === '1'

export default defineConfig({
  plugins: [aitDevtools.vite(), react()],
  define: {
    __DEBUG_BUILD__: JSON.stringify(debugBuild),
    __AIT_RELAY_KEYS__: debugBuild ? (process.env.AIT_RELAY_KEYS ?? '[]') : '[]',
  },
})
