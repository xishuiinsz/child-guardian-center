import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      '@typescript-eslint/explicit-function-return-type': 'off',
      /**
       * 与 TS 的 noUnusedParameters 约定对齐：`_` 前缀表示「故意不用」。
       *
       * 为什么必须显式配这一段：tseslint.configs.recommended 开的是 no-unused-vars 的
       * **默认选项**（argsIgnorePattern 等全部为空），而 tsc 的 noUnusedParameters
       * 天生跳过 `_` 开头的形参。两者规则不一致时，`ipcMain.handle((_, p) => {})` 这类
       * 占位写法就会 TS 侧合规、ESLint 侧报错，注释里教的约定反而过不了 lint。
       *
       * args: 'after-used' 是默认值，写出来是为了明确「只查最后一个被使用参数之后的形参」。
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ]
    }
  },
  {
    /**
     * scripts/ 下是 Node 侧的构建脚本（install-app.mjs 等，纯 JS，不进 tsconfig 的任何 program）。
     *
     * 纯 JS 写不出返回类型注解（写了 node --check 直接语法报错），所以 explicit-function-return-type
     * 只能关掉 —— 与上面 ts/tsx 那段的处理是同一个约定：该规则在本仓库一律不启用。
     * tseslint 的 eslint-recommended 覆盖只对 ts 系列文件生效，.mjs 会吃到 recommended 的默认值，
     * 因此必须在这里显式关一次。
     */
    files: ['scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
