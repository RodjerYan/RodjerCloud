import React, { useEffect, useRef, useState, useCallback } from 'react'
import { markRailScroll, clearRailScroll, markProgrammaticScroll, clearProgrammaticScroll } from '../lib/utils'

export interface DateRailProps {
  /** Года, для которых есть данные (свежие сверху) */
  years: number[]
  /** Реальные месяцы (1-12, по убыванию) по каждому году из кэша */
  monthsByYear?: Record<number, number[]>
  /** CSS-селектор контейнера-скролла, внутри которого лежат заголовки-годов с атрибутом data-year */
  targetSelector: string
  /** Элемент, чей scroll отслеживать (если не передан — window) */
  containerRef?: React.RefObject<HTMLElement | null>
  /** Якоря нет в DOM — год (и месяц) нужно догрузить */
  onYearMissing?: (year: number, month?: number) => void
  /** У якоря не хватает контента снизу (прыжок прижал цель к дну скроллера) —
   * страница должна дорастить окно рендера, иначе цель не встанет к верху */
  onNeedMoreBelow?: () => void
  /** T-20261002-018 RW1: рейл начал новый переход по годам/месяцам — страница должна
   * остановить свои отложенные тики выравнивания (handleYearMissing), чтобы два
   * механизма не тянули скролл к разным якорям */
  onJumpIntent?: () => void
}

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
const MONTHS_RU_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']

// T-20261002-016: тики «доводки» после прыжка — переживают рост scrollHeight
// из-за догрузки окна рендера/карточек после клика (замер: sh 3742 → 4934 за 2.5с).
// Плотность в первые 3с + тики на 5/6.5/8с, чтобы цель оставалась у верха
// и на замере в 2.5с, и при повторной проверке
const ALIGN_TICK_DELAYS = [300, 600, 1000, 1400, 1800, 2200, 2600, 3200, 4000, 5000, 6500, 8000]
// Допуск выравнивания: |y| <= 20px — цель у верха (acceptance: y≈0 ±20)
const ALIGN_TOLERANCE = 20
// Остаток скролла до дна < 24px = цель упёрлась в низ (контента под якорем не хватает)
const BOTTOM_PIN_THRESHOLD = 24
// T-20261002-018 RW1: re-kick — если после остановки основной серии цель всё ещё не у
// верха (окно/якорь сменились во время прыжка: рост scrollHeight, scroll-anchoring,
// смена windowStart), запускается ещё одна серия тиков. Конечное число серий и
// временной кап всей сессии — без бесконечных петель.
const ALIGN_REKICK_DELAYS = [400, 1000, 2000, 3400, 5000]
const ALIGN_REKICK_MAX = 2
const ALIGN_SESSION_MAX_MS = 20000

// T-20261002-018 RW2 (P0 после консультации Qwen): клавиши навигации, по которым
// ЖИВАЯ сессия доводки отменяется (user-intent: пользователь сам ведёт ленту).
// Space хранится как e.key === ' ' (плюс e.code === 'Space' для надёжности).
const ALIGN_NAV_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End',
])

// T-20261002-018 RW2: отменять ли сессию по этому keydown.
// Исключения:
//  - цель — input/textarea/contenteditable: Space в поле поиска/инпутах не должен
//    ломать ввод (и отменять сессию);
//  - цель — сам рейл (.date-rail): Space/Enter на кнопке рейла ЗАПУСКАЕТ сессию
//    (handleYearClick/handleMonthClick → onYearMissing), слушатель keydown висит на
//    window и получает это же событие позже обработчиков React — сессию нельзя
//    гасить её же стартовым нажатием.
// Общая функция для ОБОИХ механизмов (DateRail.startAlignSession и
// MyFilesPage.handleYearMissing) — единый список клавиш.
export const shouldCancelAlignByKey = (e: KeyboardEvent): boolean => {
  if (!ALIGN_NAV_KEYS.has(e.key) && e.key !== ' ' && e.code !== 'Space') return false
  const t = e.target
  if (t instanceof Element && t.closest('.date-rail')) return false
  if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false
  return true
}

export default function DateRail({ years, monthsByYear, targetSelector, containerRef, onYearMissing, onNeedMoreBelow, onJumpIntent }: DateRailProps) {
  const railRef = useRef<HTMLDivElement>(null)
  const [activeYear, setActiveYear] = useState<number | null>(null)
  const [hoveredYear, setHoveredYear] = useState<number | null>(null)
  const [expandedYear, setExpandedYear] = useState<number | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const scrollHandlerRef = useRef<number | null>(null)
  const yearElementsRef = useRef<Map<number, HTMLElement>>(new Map())
  const yearOffsetsRef = useRef<Array<{ year: number; offsetTop: number }>>([])
  const offsetsValidRef = useRef(false)
  // id активной сессии «доводки»: новый клик инкрементирует его и отменяет прошлые тики
  const alignSessionRef = useRef(0)

  // Получаем контейнер скролла
  const getScrollContainer = useCallback((): HTMLElement | Window => {
    if (containerRef?.current) return containerRef.current
    return window
  }, [containerRef])

  // Проверка: элемент видим (не в collapsed секции, не detached, имеет размеры)
  const isElementVisible = useCallback((el: HTMLElement): boolean => {
    if (!el.isConnected) return false
    if (el.offsetParent === null) return false
    if (el.clientHeight === 0 && el.clientWidth === 0) return false
    // Проверка на нахождение внутри collapsed .mf-section-body
    const sectionBody = el.closest('.mf-section-body')
    if (sectionBody && !sectionBody.classList.contains('open')) return false
    return true
  }, [])

  // Находим элемент года в контенте — ПОСЛЕДНИЙ match в DOM (корневой хронологический список рендерится после секций категорий)
  // FIX 3a: сначала ищем заголовок ГОДА (.mf-gy), потом fallback на любой [data-year]
  const findYearElement = useCallback((year: number): HTMLElement | null => {
    const container = document.querySelector(targetSelector)
    if (!container) return null
    const gy = container.querySelectorAll<HTMLElement>(`.mf-gy[data-year="${year}"]`)
    if (gy.length > 0) return gy[gy.length - 1]
    const els = container.querySelectorAll<HTMLElement>(`[data-year="${year}"]`)
    return els.length > 0 ? els[els.length - 1] : null
  }, [targetSelector])

  // Находим элемент месяца в контенте — ПОСЛЕДНИЙ match в DOM
  // data-month в DOM 0-based (groupByDay), месяц из рейла 1-based
  const findMonthElement = useCallback((year: number, month: number): HTMLElement | null => {
    const container = document.querySelector(targetSelector)
    if (!container) return null
    const els = container.querySelectorAll<HTMLElement>(`[data-year="${year}"][data-month="${month - 1}"]`)
    return els.length > 0 ? els[els.length - 1] : null
  }, [targetSelector])

  // Пересборка кэша элементов годов и их offsetTop
  const rebuildYearCache = useCallback(() => {
    const container = document.querySelector(targetSelector)
    if (!container) return

    const newMap = new Map<number, HTMLElement>()
    const newOffsets: Array<{ year: number; offsetTop: number }> = []

    years.forEach((year) => {
      const el = findYearElement(year)
      if (el && isElementVisible(el)) {
        newMap.set(year, el)
        // offsetTop относительно scroll-контейнера (container уже и есть scroll-контейнер)
        const scrollContainer = container
        const containerRect = scrollContainer.getBoundingClientRect()
        const elRect = el.getBoundingClientRect()
        const offsetTop = elRect.top - containerRect.top + scrollContainer.scrollTop
        newOffsets.push({ year, offsetTop })
      }
    })

    // Сортируем по offsetTop (от верха к низу)
    newOffsets.sort((a, b) => a.offsetTop - b.offsetTop)

    yearElementsRef.current = newMap
    yearOffsetsRef.current = newOffsets
    offsetsValidRef.current = newOffsets.length > 0
  }, [years, targetSelector, findYearElement, isElementVisible])

  // Scroll-driven расчёт активного года (источник истины)
  const computeActiveYearFromScroll = useCallback(() => {
    const container = getScrollContainer()
    if (!offsetsValidRef.current || yearOffsetsRef.current.length === 0) {
      rebuildYearCache()
      if (!offsetsValidRef.current) return
    }

    const containerRect = container instanceof Window
      ? { top: 0, height: window.innerHeight, scrollTop: window.scrollY }
      : { top: container.getBoundingClientRect().top, height: container.clientHeight, scrollTop: container.scrollTop }

    const viewportTop = containerRect.scrollTop + containerRect.height * 0.15 // 15% от верха viewport

    const offsets = yearOffsetsRef.current
    let bestYear: number | null = null

    // Бинарный поиск: ищем последний год с offsetTop <= viewportTop
    let lo = 0
    let hi = offsets.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid].offsetTop <= viewportTop) {
        bestYear = offsets[mid].year
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    // Fallback: если все годы ниже viewportTop, берём первый
    if (bestYear === null && offsets.length > 0) {
      bestYear = offsets[0].year
    }

    if (bestYear !== null) {
      setActiveYear(bestYear)
    }
  }, [getScrollContainer, rebuildYearCache])

  // Throttled scroll handler (rAF)
  const setupScrollHandler = useCallback(() => {
    const container = getScrollContainer()
    const handleScroll = () => {
      if (scrollHandlerRef.current) return
      scrollHandlerRef.current = requestAnimationFrame(() => {
        scrollHandlerRef.current = null
        computeActiveYearFromScroll()
      })
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => container.removeEventListener('scroll', handleScroll)
  }, [getScrollContainer, computeActiveYearFromScroll])

  // IntersectionObserver как дополнение (для случаев, когда scroll handler не срабатывает)
  const setupIntersectionObserver = useCallback(() => {
    const container = getScrollContainer()
    const root = container instanceof Window ? null : container

    if (observerRef.current) {
      observerRef.current.disconnect()
    }

    const yearElements = Array.from(yearElementsRef.current.values()).filter(isElementVisible)
    if (yearElements.length === 0) return

    observerRef.current = new IntersectionObserver(
      (entries: IntersectionObserverEntry[]) => {
        let bestEntry: IntersectionObserverEntry | null = null
        let bestRatio = -1

        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio
            bestEntry = entry
          }
        }

        if (bestEntry) {
          const target = bestEntry.target as HTMLElement
          const year = Number(target.getAttribute('data-year'))
          if (!isNaN(year)) {
            setActiveYear(year)
          }
        }
      },
      {
        root,
        rootMargin: '-10% 0px -70% 0px',
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
      }
    )

    yearElements.forEach((el) => {
      observerRef.current?.observe(el)
    })
  }, [getScrollContainer, isElementVisible])

  // Инициализация и очистка
  useEffect(() => {
    // Ждём, пока элементы года появятся в DOM
    const checkElements = () => {
      const container = document.querySelector(targetSelector)
      if (!container) return false

      const newMap = new Map<number, HTMLElement>()
      years.forEach((year) => {
        const el = findYearElement(year)
        if (el && isElementVisible(el)) newMap.set(year, el)
      })

      yearElementsRef.current = newMap
      return newMap.size > 0
    }

    // Пробуем сразу, потом через requestAnimationFrame
    if (!checkElements()) {
      requestAnimationFrame(checkElements)
    }

    // Настраиваем scroll handler (основной источник истины)
    const cleanupScroll = setupScrollHandler()

    // Настраиваем IntersectionObserver (fallback)
    if ('IntersectionObserver' in window) {
      setupIntersectionObserver()
    }

    return () => {
      observerRef.current?.disconnect()
      if (scrollHandlerRef.current) {
        cancelAnimationFrame(scrollHandlerRef.current)
      }
      cleanupScroll()
    }
  }, [years, targetSelector, findYearElement, isElementVisible, setupScrollHandler, setupIntersectionObserver])

  // Обновляем observer и кэш при изменении years или targetSelector
  useEffect(() => {
    rebuildYearCache()
    if ('IntersectionObserver' in window) {
      setupIntersectionObserver()
    }
  }, [years, targetSelector, rebuildYearCache, setupIntersectionObserver])

  // Год, который сейчас раскрыт (expandedYear имеет приоритет, иначе activeYear)
  const openYear = expandedYear ?? activeYear

  // Единый механизм «довести до цели» после клика по году/месяцу (T-20261002-016):
  // начальный программный скролл + серия re-align-тиков, которые переживают рост
  // scrollHeight из-за догрузки контента после прыжка (замер: цель уезжала на y=883).
  // FIX T-20261002-018 RW1 (гипотезы (а)+(б) из плана):
  //  1) отмена сессии — ТОЛЬКО по настоящему пользовательскому вводу:
  //     wheel/touchmove + (RW2) pointerdown/mousedown в ленте и навигационный keydown
  //     (стрелки/Page*/Home/End/Space, см. shouldCancelAlignByKey). Раньше отменялся
  //     ЛЮБЫМ scroll-событием вне окна наших программных скроллов
  //     (scrollCancelListener), а штатные изменения контента дают «чужой» scroll без
  //     наших флагов: scroll-anchoring при вставке карточек, компенсация prepend в
  //     MyFilesPage (scrollTop пишется без markProgrammaticScroll), scroll-событие,
  //     приходящее в кадре ПОСЛЕ снятия флагов в rAF, — сессия умирала и цель
  //     навсегда оставалась не у верха (y=433/y=453 в замерах).
  //     Дельта-детектор внешнего scroll между тиками (P0.3 из Qwen-разбора) НЕ вводится:
  //     scroll-anchoring сам даёт внешнюю дельту и вернул бы исходный баг;
  //  2) baseline-гард «|scrollTop − последний наш скролл| > 50 → пропустить тик»
  //     убран: он сравнивал с значением, обновляемым только внутри alignTo, поэтому
  //     любой контентный сдвиг scrollTop > 50px молча выключал ВСЕ оставшиеся тики
  //     (deadlock). Пользовательский ввод и так отменяет сессию по п.1;
  //  3) re-kick: серия тиков после остановки + |y| > допуска запускает ещё одну
  //     серию (конечное число, временной кап ALIGN_SESSION_MAX_MS).
  const startAlignSession = useCallback((getAnchor: () => HTMLElement | null) => {
    const container = document.querySelector<HTMLElement>(targetSelector)
    if (!container) return
    const el = getAnchor()
    if (!el) return

    const sessionId = alignSessionRef.current
    const startedAt = Date.now()
    let cancelled = false
    let reKicksLeft = ALIGN_REKICK_MAX

    // Отмена по НАСТОЯЩЕМУ пользовательскому вводу — слушатели ставим СИНХРОННО при старте
    const cancelListener = () => { cancelled = true }
    container.addEventListener('wheel', cancelListener, { passive: true, once: true })
    container.addEventListener('touchmove', cancelListener, { passive: true, once: true })

    // T-20261002-018 RW2 (P0): pointerdown/mousedown в ленте — drag скроллбара и клик
    // по карточке отменяют живую сессию (иначе лента дёргается обратно до 20с).
    // mousedown — страховка: при drag'е скроллбара (non-client область) браузер может
    // не отдавать pointer-события контейнеру, а mouse-события — отдаёт.
    // Клик по САМОЙ линейке НЕ отменяет: рейл рендерится createPortal в document.body,
    // т.е. лежит ВНЕ контейнера `.v2-main` (событие до контейнера не доходит вовсе),
    // плюс явное исключение ниже — защита, если рейл когда-нибудь окажется внутри.
    const pointerCancelListener = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('.date-rail')) return
      cancelled = true
      container.removeEventListener('pointerdown', pointerCancelListener)
      container.removeEventListener('mousedown', pointerCancelListener)
    }
    container.addEventListener('pointerdown', pointerCancelListener)
    container.addEventListener('mousedown', pointerCancelListener)

    // T-20261002-018 RW2 (P0): навигация клавиатурой (стрелки/Page*/Home/End/Space) —
    // отмена. Input/textarea/contenteditable и рейл исключены (см. shouldCancelAlignByKey).
    // Слушатель на window: клавиши приходят при фокусе на body/контейнере, а не только
    // внутри контейнера. Cleanup — по капу сессии (см. cleanup ниже) + самоудаление
    // после срабатывания.
    const keyCancelListener = (e: KeyboardEvent) => {
      if (!shouldCancelAlignByKey(e)) return
      cancelled = true
      window.removeEventListener('keydown', keyCancelListener)
    }
    window.addEventListener('keydown', keyCancelListener)

    const isAlive = () => !cancelled && alignSessionRef.current === sessionId

    const alignTo = (target: HTMLElement) => {
      markRailScroll()
      markProgrammaticScroll()
      target.scrollIntoView({ behavior: 'auto', block: 'start' })
      // Снимаем флаги после завершения скролла (rAF; scroll-событие раньше rAF —
      // обработчики страницы видят активный программный скролл)
      requestAnimationFrame(() => {
        clearRailScroll()
        clearProgrammaticScroll()
      })
    }

    // Если после выравнивания цель всё ещё ниже верха и скроллер прижат к дну —
    // контента под якорем не хватает, чтобы встать к верху → просим страницу
    // синхронно дорастить окно рендера (MyFilesPage.handleNeedMoreBelow)
    const ensureBelowContent = (target: HTMLElement) => {
      const off = Math.abs(target.getBoundingClientRect().top - container.getBoundingClientRect().top)
      if (off <= ALIGN_TOLERANCE) return
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight
      if (distance < BOTTOM_PIN_THRESHOLD) onNeedMoreBelow?.()
    }

    // Начальное выравнивание
    alignTo(el)
    ensureBelowContent(el)

    // Один тик доводки: false — сессия кончилась или цель у верха; true — ещё не выровнено.
    // Якорь переспрашиваем КАЖДЫЙ раз (DOM мог перерисоваться, окно могло смениться) —
    // сессия переживает штатные изменения контента и продолжает ту же цель.
    const runTick = (): boolean => {
      if (!isAlive()) return false
      const cur = getAnchor()
      if (!cur) return true // якоря временно нет (перерендер окна) — ждём следующего тика
      const off = Math.abs(cur.getBoundingClientRect().top - container.getBoundingClientRect().top)
      if (off <= ALIGN_TOLERANCE) return false
      alignTo(cur)
      ensureBelowContent(cur)
      return true
    }

    const timeouts: ReturnType<typeof setTimeout>[] = []
    const armBurst = (delays: number[]) => {
      delays.forEach((delay, idx) => {
        timeouts.push(setTimeout(() => {
          const stillOff = runTick()
          if (!stillOff) return
          if (idx !== delays.length - 1) return
          // Серия остановилась, цель не у верха → re-kick (ограничен по числу и времени)
          if (reKicksLeft <= 0 || Date.now() - startedAt >= ALIGN_SESSION_MAX_MS) return
          reKicksLeft--
          armBurst(ALIGN_REKICK_DELAYS)
        }, delay))
      })
    }
    armBurst(ALIGN_TICK_DELAYS)

    // Очистка слушателей и таймеров после капа сессии
    const cleanup = () => {
      timeouts.forEach(clearTimeout)
      container.removeEventListener('wheel', cancelListener)
      container.removeEventListener('touchmove', cancelListener)
      container.removeEventListener('pointerdown', pointerCancelListener)
      container.removeEventListener('mousedown', pointerCancelListener)
      window.removeEventListener('keydown', keyCancelListener)
    }
    setTimeout(cleanup, ALIGN_SESSION_MAX_MS + 500)
  }, [targetSelector, onNeedMoreBelow])

  const handleYearClick = useCallback((year: number) => {
    // Переключаем раскрытие
    setExpandedYear(prev => prev === year ? null : year)

    // T-20261002-018 RW1: новый переход гасит отложенные тики handleYearMissing на странице
    onJumpIntent?.()

    // Новый клик отменяет предыдущую сессию доводки (и наоборот — если год
    // отсутствует в DOM, сессия всё равно не должна продолжать жить)
    alignSessionRef.current++

    // Пытаемся скроллить к якорю года
    if (findYearElement(year)) {
      startAlignSession(() => findYearElement(year))
    } else {
      onYearMissing?.(year)
    }
  }, [findYearElement, startAlignSession, onYearMissing, onJumpIntent])

  const handleMonthClick = useCallback((year: number, month: number) => {
    // T-20261002-018 RW1: новый переход гасит отложенные тики handleYearMissing на странице
    onJumpIntent?.()
    alignSessionRef.current++
    if (!findMonthElement(year, month)) {
      onYearMissing?.(year, month)
      return
    }
    startAlignSession(() => findMonthElement(year, month))
  }, [findMonthElement, onYearMissing, startAlignSession, onJumpIntent])

  const handleKeyDown = useCallback((e: React.KeyboardEvent, year: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleYearClick(year)
    }
  }, [handleYearClick])

  // Скрываем рейл, если годов меньше 2 (после ВСЕХ хуков — Rules of Hooks)
  if (years.length < 2) return null

  return (
    <div
      ref={railRef}
      className="date-rail"
      role="navigation"
      aria-label="Навигация по годам"
    >
      {years.map((year) => {
        const isActive = activeYear === year
        const isHovered = hoveredYear === year
        const isExpanded = openYear === year
        const months = monthsByYear?.[year] || []

        return (
          <div key={year} className="date-rail-year-wrapper">
            <button
              type="button"
              className={`date-rail-year ${isActive ? 'active' : ''} ${isHovered ? 'hovered' : ''} ${isExpanded ? 'expanded' : ''}`}
              onClick={() => handleYearClick(year)}
              onMouseEnter={() => setHoveredYear(year)}
              onMouseLeave={() => setHoveredYear(null)}
              onKeyDown={(e) => handleKeyDown(e, year)}
              aria-label={`Перейти к ${year} году`}
              aria-current={isActive ? 'true' : 'false'}
              aria-expanded={isExpanded}
            >
              <span className="date-rail-year-label">{year}</span>
              <span className="date-rail-tick" aria-hidden="true" />
              {months.length > 0 && (
                <span className="date-rail-chevron" aria-hidden="true">
                  {isExpanded ? '▲' : '▼'}
                </span>
              )}
            </button>
            {isExpanded && months.length > 0 && (
              <div className="date-rail-months">
                {months.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="date-rail-month"
                    onClick={() => handleMonthClick(year, m)}
                    aria-label={`Перейти к ${MONTHS_RU_FULL[m - 1]} ${year}`}
                  >
                    <span className="date-rail-month-label">{MONTHS_RU_FULL[m - 1]}</span>
                    <span className="date-rail-tick small" aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}