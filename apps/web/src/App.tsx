import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MutableRefObject,
} from "react";
import type { ConflictResolution } from "@daymark/contracts";
import type {
  ActionRequiredSyncIssue,
  ManualCaptureResolution,
} from "@daymark/application";
import { semesterForDate } from "@daymark/domain";
import type {
  Course,
  CourseInformation,
  CourseSchedule,
  Item,
  ItemAssociation,
  RawCapture,
  Semester,
  SemesterWeek,
} from "@daymark/domain";
import { daymark, localRepository } from "./services.js";
import { ItemList } from "./ItemList.js";
import { ItemDetail, type EditableItemFields } from "./ItemDetail.js";
import { QuickCapture } from "./QuickCapture.js";
import { CourseInformationList } from "./CourseInformationList.js";
import { PendingCapture } from "./PendingCapture.js";
import {
  authClient,
  abandonActionRequiredIssue,
  currentAccessToken,
  openActionRequiredIssues,
  requestCaptureInterpretation,
  requestSyncNow,
  resolveSyncConflict,
  retryActionRequiredIssue,
  retryAuthenticatedSync,
  startAuthenticatedSync,
  type AuthenticatedSyncStatus,
} from "./authSync.js";
import { ConflictPanel } from "./ConflictPanel.js";
import { AccountControl } from "./AccountControl.js";
import { LanguageSwitcher } from "./LanguageSwitcher.js";
import type { ConflictDetail } from "./syncTransport.js";
import { CalendarView } from "./CalendarView.js";
import { CourseIndex } from "./CourseIndex.js";
import {
  commitCourseImport,
  discardCourseImport,
  pendingCourseImports,
  resolveImportedCourse,
  retryCourseImport,
  startCourseImport,
} from "./courseImportClient.js";
import { CourseDeleteConfirmation } from "./CourseDeleteConfirmation.js";
import {
  CourseScheduleList,
  type ScheduleFields,
} from "./CourseScheduleList.js";
import { SemesterSwitcher } from "./SemesterSwitcher.js";
import type { WeekFields } from "./SemesterWeekEditor.js";
import { localDate } from "./timeInputs.js";
import { SyncRepairPanel } from "./SyncRepairPanel.js";
import { AppNavigation, type PrimaryPage } from "./AppNavigation.js";
import { GlobalSearchButton, SearchSurface } from "./SearchSurface.js";
import { AttentionSummary } from "./AttentionSummary.js";
import {
  ErrorNotice,
  TransientFeedback,
  type FeedbackNotice,
} from "./TransientNotice.js";
import { motionDuration } from "./motion.js";
import {
  ReminderScheduler,
  WebReminderDeliveryPort,
  createAppReminderWindow,
  loadReminderPolicy,
  loadReminderRuntimeConfig,
  localDeviceId,
} from "./reminders.js";
import { createNotificationAdapter } from "./shellNotifications.js";
import { getVersion } from "@tauri-apps/api/app";
import {
  checkForUpdate,
  installUpdate,
  releaseUpdate,
  type UpdateInfo,
} from "./updateService.js";
import { UpdateDialog } from "./UpdateDialog.js";
import { FirstLaunchGuide } from "./FirstLaunchGuide.js";
import {
  openReadyUpdate,
  reconcileReadyMarker,
  UPDATE_READY_KEY,
} from "./updateService.js";
import { toUserMessage } from "./errors.js";
import type { AiTaskKind } from "./aiTaskStore.js";
import { apiBase, isAndroid, isTauri } from "./apiBase.js";
import WindowTitleBar from "./WindowTitleBar.js";
import { useT } from "./i18n/index.js";

export function App() {
  const t = useT();
  const [page, setPage] = useState<PrimaryPage>("overview");
  /** Bumped to reopen the import panel when a finished AI task is clicked. */
  const [importOpenSignal, setImportOpenSignal] = useState(0);
  const [initializing, setInitializing] = useState(true);
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine,
  );
  const [currentCourseId, setCurrentCourseId] = useState<string | null>(null);
  const [showCourseDelete, setShowCourseDelete] = useState(false);
  const [courses, setCourses] = useState<Course[]>([]);
  const [overviewItems, setOverviewItems] = useState<Item[]>([]);
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [courseItems, setCourseItems] = useState<Item[]>([]);
  const [calendarItems, setCalendarItems] = useState<Item[]>([]);
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [semesterWeeks, setSemesterWeeks] = useState<SemesterWeek[]>([]);
  const [selectedSemesterId, setSelectedSemesterId] = useState<string | null>(
    null,
  );
  const [courseInformation, setCourseInformation] = useState<
    CourseInformation[]
  >([]);
  const [searchCourseInformation, setSearchCourseInformation] = useState<
    CourseInformation[]
  >([]);
  const [courseSchedules, setCourseSchedules] = useState<CourseSchedule[]>([]);
  const [courseTab, setCourseTab] = useState<
    "items" | "information" | "schedule"
  >("items");
  const [unresolved, setUnresolved] = useState<RawCapture[]>([]);
  const [unresolvedContexts, setUnresolvedContexts] = useState<
    Record<string, string | null>
  >({});
  const [dismissedThisLaunch, setDismissedThisLaunch] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);
  const [selectedRaw, setSelectedRaw] = useState<RawCapture | null>(null);
  const [itemAssociations, setItemAssociations] = useState<ItemAssociation[]>(
    [],
  );
  const [pendingMoveIds, setPendingMoveIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [enteringItemIds, setEnteringItemIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [feedback, setFeedback] = useState<FeedbackNotice | null>(null);
  const [courseItemText, setCourseItemText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [syncConflicts, setSyncConflicts] = useState<ConflictDetail[]>([]);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(
    null,
  );
  const [updateReady, setUpdateReady] = useState(false);
  const [updatePermissionHint, setUpdatePermissionHint] = useState(false);
  const [syncIssues, setSyncIssues] = useState<ActionRequiredSyncIssue[]>([]);
  // Bumped by the account panel's 查看并处理 so the repair panel opens itself.
  const [repairOpenSignal, setRepairOpenSignal] = useState(0);
  const [syncStatus, setSyncStatus] = useState<AuthenticatedSyncStatus>(() => ({
    state: authClient ? "SIGNED_OUT" : "LOCAL_ONLY",
    checked_at: null,
  }));
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingExpanded, setPendingExpanded] = useState(true);
  const [highlightedInformationId, setHighlightedInformationId] = useState<
    string | null
  >(null);
  const detailRequestIdRef = useRef(0);
  const selectedItemIdRef = useRef<string | null>(null);
  selectedItemIdRef.current = selectedItem?.id ?? null;
  const completionTimersRef = useRef<Map<string, number>>(new Map());
  const deletionTimersRef = useRef<Map<string, number>>(new Map());
  const enteringTimersRef = useRef<Map<string, number>>(new Map());
  const feedbackIdRef = useRef(0);
  const allItemsRef = useRef<Item[]>([]);
  allItemsRef.current = allItems;
  const openItemRef = useRef<(item: Item) => void>(() => {});
  openItemRef.current = openItem;
  const reminderTickRef = useRef<(() => Promise<number>) | null>(null);

  const refresh = useCallback(async () => {
    const now = new Date().toISOString();
    const today = localDate();
    const requestedSelectedItemId = selectedItem?.id ?? null;
    const [
      courseData,
      allItemData,
      overviewData,
      unresolvedData,
      courseItemData,
      courseInformationData,
      allCourseInformationData,
      courseScheduleData,
      calendarData,
      semesterData,
      selectedAssociationData,
    ] = await Promise.all([
      daymark.listCourses(),
      daymark.listItems(),
      daymark.overview(today, now, selectedSemesterId ?? undefined),
      daymark.unresolvedCaptures(),
      currentCourseId
        ? daymark.courseItems(currentCourseId, now)
        : Promise.resolve([]),
      currentCourseId
        ? daymark.courseInformation(currentCourseId)
        : Promise.resolve([]),
      daymark.allCourseInformation(),
      currentCourseId
        ? daymark.courseSchedules(currentCourseId)
        : Promise.resolve([]),
      daymark.calendarItems(),
      daymark.listSemesters(),
      selectedItem
        ? daymark.itemAssociations(selectedItem.id)
        : Promise.resolve([]),
    ]);
    const weekGroups = await Promise.all(
      semesterData.map((semester) => daymark.semesterWeeks(semester.id)),
    );
    setCourses(courseData);
    setAllItems(allItemData);
    setOverviewItems(overviewData);
    setUnresolved(unresolvedData);
    setUnresolvedContexts(
      Object.fromEntries(
        await Promise.all(
          unresolvedData.map(async (capture) => [
            capture.id,
            await daymark.courseContextForCapture(capture.id),
          ]),
        ),
      ),
    );
    setCourseItems(courseItemData);
    setCourseInformation(courseInformationData);
    setSearchCourseInformation(allCourseInformationData);
    setCourseSchedules(courseScheduleData);
    setCalendarItems(calendarData);
    setSemesters(semesterData);
    setSemesterWeeks(weekGroups.flat());
    if (selectedItemIdRef.current === requestedSelectedItemId) {
      setItemAssociations(selectedAssociationData);
      if (requestedSelectedItemId) {
        const next = await daymark.getItem(requestedSelectedItemId);
        if (selectedItemIdRef.current !== requestedSelectedItemId) return;
        if (next?.deleted_at) setSelectedItem(null);
        else if (next) setSelectedItem(next);
      }
    }
    // Completion, deletion and time edits land here, so stale reminder keys
    // are canceled promptly instead of waiting for the interval.
    void reminderTickRef.current?.();
    // A local write should reach the other device without waiting for the
    // next poll tick; no-ops unless the outbox actually holds something.
    requestSyncNow();
  }, [currentCourseId, selectedItem?.id, selectedSemesterId]);

  useEffect(() => {
    let active = true;
    void refresh()
      .catch((cause: unknown) => setError(toUserMessage(cause)))
      .finally(() => {
        if (active) setInitializing(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  // Update check (shell only): desktop goes through the official updater
  // plugin, Android through the same manifest + custom APK install.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void (async () => {
      try {
        const version = await getVersion();
        const info = await checkForUpdate(version);
        console.info(
          "[UPDATE_CHECK]",
          version,
          info ? `v${info.version}` : "none",
        );
        if (alive && info) setAvailableUpdate(info);
      } catch (cause) {
        console.error("[UPDATE_CHECK_ERR]", cause);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // A finished update download (Android): surface an in-app dialog on the
  // event (foreground completion) or on next launch (the marker survives a
  // failed/dismissed notification tap — a finished download is never lost).
  // The launch-time marker is reconciled against the downloaded package
  // first, so a stale marker (file gone / already installed) is dropped
  // instead of showing a dead install dialog.
  useEffect(() => {
    if (!isAndroid()) return;
    let alive = true;
    void (async () => {
      try {
        if (!localStorage.getItem(UPDATE_READY_KEY)) return;
        const version = await getVersion();
        const stillPending = await reconcileReadyMarker(version);
        if (alive && stillPending) setUpdateReady(true);
      } catch {
        // storage / shell command unavailable — the event path still works
      }
    })();
    const onReady = () => setUpdateReady(true);
    window.addEventListener("daymark-update-ready", onReady);
    return () => {
      alive = false;
      window.removeEventListener("daymark-update-ready", onReady);
    };
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // Reminder delivery: derive the schedule with the product R-01 policy,
  // claim while online, then show a platform notification.
  useEffect(() => {
    const policy = loadReminderPolicy();
    const runtime = loadReminderRuntimeConfig();
    let scheduler: ReminderScheduler | null = null;
    const adapter = createNotificationAdapter({
      openItem: (item, logicalKey) => {
        void scheduler?.consume(logicalKey);
        openItemRef.current(item);
      },
      getItem: (itemId) => localRepository.getItem(itemId),
      notice: (title) =>
        showFeedback({
          message: t("app.toastReminderPrefix", { title }),
          duration: motionDuration.feedback,
        }),
    });
    adapter.armPermissionRequest();
    let registered = false;
    const delivery = new WebReminderDeliveryPort(adapter, {
      deviceId: localDeviceId,
      getItem: (itemId) => localRepository.getItem(itemId),
      accessToken: currentAccessToken,
      registerDevice: async (platform) => {
        if (registered) return;
        const token = await currentAccessToken();
        if (!token) return;
        registered = true;
        await fetch(`${apiBase()}/api/v1/devices`, {
          method: "POST",
          headers: {
            authorization: ["Bearer", token].join(" "),
            "content-type": "application/json",
          },
          body: JSON.stringify({ device_id: localDeviceId(), platform }),
        }).catch(() => undefined);
      },
    });
    scheduler = new ReminderScheduler({
      repository: localRepository,
      policy,
      delivery,
      items: () => allItemsRef.current,
    });
    const engine = scheduler;
    const windowFor = () =>
      createAppReminderWindow(
        new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
        new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        runtime,
      );
    // Every tick also hands FUTURE reminders to the OS (Android): the 15 s
    // heartbeat only lives as long as the app process, so a killed app would
    // otherwise never fire — and then dump them all on the next open.
    const syncScheduled = () => {
      void (async () => {
        const records = await localRepository.listReminderRecords();
        const horizon = Date.now() + 14 * 24 * 60 * 60 * 1000;
        for (const record of records) {
          if (record.state !== "PENDING") continue;
          const due = Date.parse(record.scheduled_for);
          if (!(due > Date.now() + 5_000 && due <= horizon)) continue;
          const item = await localRepository.getItem(record.item_id);
          if (item) adapter.schedule?.(record, item);
        }
      })().catch(() => undefined);
    };
    const tick = () => {
      const run = engine.tick(windowFor());
      syncScheduled();
      return run;
    };
    reminderTickRef.current = tick;
    void tick().catch(() => undefined);
    const interval = window.setInterval(
      () => void tick().catch(() => undefined),
      15_000,
    );
    const onVisible = () => {
      if (!document.hidden) void tick().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      reminderTickRef.current = null;
    };
  }, []);
  useEffect(() => {
    window.scrollTo({ left: 0, top: 0 });
  }, [currentCourseId, page]);
  useEffect(() => {
    void daymark
      .recoverPendingCaptures()
      .then(refresh)
      .catch((cause: unknown) => setError(toUserMessage(cause)));
    void openActionRequiredIssues().then(setSyncIssues);
  }, []);

  // Scrollbars only light up on the element that is actually scrolling
  // (class removed again after a short idle), so an opened detail panel
  // never shows two rails at once.
  useEffect(() => {
    let timer = 0;
    const onScroll = (event: Event) => {
      const raw = event.target;
      const target =
        raw === document ? document.documentElement : (raw as Element | null);
      if (!target || !(target instanceof Element)) return;
      window.clearTimeout(timer);
      for (const el of document.querySelectorAll(".is-scrolling"))
        el.classList.remove("is-scrolling");
      target.classList.add("is-scrolling");
      timer = window.setTimeout(() => {
        target.classList.remove("is-scrolling");
      }, 700);
    };
    document.addEventListener("scroll", onScroll, {
      passive: true,
      capture: true,
    });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.clearTimeout(timer);
    };
  }, []);
  useEffect(
    () =>
      startAuthenticatedSync(
        () => {
          void refresh();
        },
        () => setError(t("app.ownerMismatch")),
        setSyncConflicts,
        setSyncIssues,
        setSyncStatus,
      ),
    [refresh],
  );
  useEffect(
    () => () => {
      for (const timer of completionTimersRef.current.values())
        window.clearTimeout(timer);
      for (const timer of deletionTimersRef.current.values())
        window.clearTimeout(timer);
      for (const timer of enteringTimersRef.current.values())
        window.clearTimeout(timer);
    },
    [],
  );

  function replaceItemLocally(nextItem: Item) {
    const replace = (items: Item[]) =>
      items.map((value) => (value.id === nextItem.id ? nextItem : value));
    setOverviewItems(replace);
    setCourseItems(replace);
    setCalendarItems(replace);
    setAllItems(replace);
    if (selectedItem?.id === nextItem.id) setSelectedItem(nextItem);
  }

  function showFeedback(value: Omit<FeedbackNotice, "id">) {
    feedbackIdRef.current += 1;
    setFeedback({ ...value, id: feedbackIdRef.current });
  }

  function clearMotionTimer(
    timers: MutableRefObject<Map<string, number>>,
    itemId: string,
  ) {
    const timer = timers.current.get(itemId);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(itemId);
  }

  function markItemEntering(itemId: string) {
    clearMotionTimer(enteringTimersRef, itemId);
    setEnteringItemIds((ids) => new Set(ids).add(itemId));
    enteringTimersRef.current.set(
      itemId,
      window.setTimeout(() => {
        enteringTimersRef.current.delete(itemId);
        setEnteringItemIds((ids) => {
          const next = new Set(ids);
          next.delete(itemId);
          return next;
        });
      }, motionDuration.slow),
    );
  }

  function closeItemDetail() {
    detailRequestIdRef.current += 1;
    selectedItemIdRef.current = null;
    setSelectedItem(null);
    setSelectedRaw(null);
    setItemAssociations([]);
  }

  async function saveCapture(text: string, courseId: string | null = null) {
    try {
      const raw = await daymark.capture(
        text,
        courseId ? "COURSE_ITEM" : "QUICK_CAPTURE",
        courseId,
      );
      if (courseId)
        showFeedback({
          message: t("app.toastRecorded"),
          duration: motionDuration.feedback,
        });
      void daymark
        .processClearCapture(raw.id, courseId)
        .then(refresh)
        .catch((cause: unknown) => setError(toUserMessage(cause)));
    } catch (cause) {
      setError(t("app.toastSaveFailed", { error: toUserMessage(cause) }));
      throw cause;
    }
  }

  async function openItem(item: Item) {
    const requestId = ++detailRequestIdRef.current;
    selectedItemIdRef.current = item.id;
    setSelectedItem(item);
    setSelectedRaw(null);
    setItemAssociations([]);
    const [rawCapture, associations] = await Promise.all([
      daymark.rawCaptureForItem(item.id),
      daymark.itemAssociations(item.id),
    ]);
    if (detailRequestIdRef.current !== requestId) return;
    setSelectedRaw(rawCapture ?? null);
    setItemAssociations(associations);
  }

  async function addItemAssociation(associatedItemId: string) {
    if (!selectedItem) return;
    await daymark.associateItems(selectedItem.id, associatedItemId);
    setItemAssociations(await daymark.itemAssociations(selectedItem.id));
  }

  async function removeItemAssociation(associationId: string) {
    if (!selectedItem) return;
    await daymark.deleteItemAssociation(associationId);
    setItemAssociations(await daymark.itemAssociations(selectedItem.id));
  }

  async function complete(item: Item) {
    try {
      const completed = await daymark.completeItem(item.id);
      clearMotionTimer(completionTimersRef, item.id);
      setPendingMoveIds((ids) => new Set(ids).add(item.id));
      replaceItemLocally(completed);
      showFeedback({
        message: t("app.toastCompleted"),
        duration: motionDuration.feedback,
        action: async () => {
          clearMotionTimer(completionTimersRef, item.id);
          const restored = await daymark.restoreItem(item.id);
          setPendingMoveIds((ids) => {
            const next = new Set(ids);
            next.delete(item.id);
            return next;
          });
          replaceItemLocally(restored);
          await refresh();
          markItemEntering(item.id);
        },
      });
      completionTimersRef.current.set(
        item.id,
        window.setTimeout(() => {
          completionTimersRef.current.delete(item.id);
          setPendingMoveIds((ids) => {
            const next = new Set(ids);
            next.delete(item.id);
            return next;
          });
          void refresh().then(() => markItemEntering(item.id));
        }, motionDuration.completionHold + motionDuration.medium),
      );
    } catch (cause) {
      setError(toUserMessage(cause));
    }
  }

  async function restore(item: Item) {
    try {
      const restored = await daymark.restoreItem(item.id);
      replaceItemLocally(restored);
      await refresh();
      markItemEntering(item.id);
    } catch (cause) {
      setError(toUserMessage(cause));
    }
  }

  async function remove(item: Item): Promise<boolean> {
    try {
      const deleted = await daymark.deleteItem(item.id);
      clearMotionTimer(deletionTimersRef, item.id);
      setPendingDeleteIds((ids) => new Set(ids).add(item.id));
      showFeedback({
        message: t("app.toastDeletedTitle", { title: item.title }),
        duration: motionDuration.feedback,
        action: async () => {
          clearMotionTimer(deletionTimersRef, item.id);
          setPendingDeleteIds((ids) => {
            const next = new Set(ids);
            next.delete(item.id);
            return next;
          });
          const restored = await daymark.undoDelete(item.id, deleted.token);
          replaceItemLocally(restored);
          await refresh();
          markItemEntering(item.id);
        },
      });
      deletionTimersRef.current.set(
        item.id,
        window.setTimeout(() => {
          deletionTimersRef.current.delete(item.id);
          setPendingDeleteIds((ids) => {
            const next = new Set(ids);
            next.delete(item.id);
            return next;
          });
          void refresh();
        }, motionDuration.panel),
      );
      return true;
    } catch (cause) {
      setError(toUserMessage(cause));
      return false;
    }
  }

  async function saveEdit(item: Item, fields: EditableItemFields) {
    try {
      setSelectedItem(await daymark.updateItem(item.id, fields));
      await refresh();
    } catch (cause) {
      setError(toUserMessage(cause));
      throw cause;
    }
  }

  async function addCourseItem(event: FormEvent) {
    event.preventDefault();
    if (!currentCourseId || !courseItemText.trim()) return;
    try {
      await saveCapture(courseItemText, currentCourseId);
      setCourseItemText("");
    } catch {
      /* saveCapture already reports the failure */
    }
  }

  async function addInformation(content: string) {
    if (!currentCourseId) return;
    try {
      await daymark.addCourseInformation(currentCourseId, content);
      await refresh();
    } catch (cause) {
      setError(toUserMessage(cause));
      throw cause;
    }
  }

  async function replaceSchedules(values: ScheduleFields[]) {
    if (!currentCourseId) return;
    await daymark.replaceCourseSchedules(currentCourseId, values);
    await refresh();
  }

  async function deleteCourse(
    strategy: "DELETE_ASSOCIATED_ITEMS" | "UNLINK_ASSOCIATED_ITEMS",
  ) {
    if (!activeCourse) return;
    await daymark.deleteCourseWithStrategy(
      activeCourse.id,
      strategy,
      courseItems.map((item) => item.id),
    );
    setCurrentCourseId(null);
    setShowCourseDelete(false);
    setSelectedItem(null);
    showFeedback({ message: t("app.toastCourseDeleted"), duration: 4000 });
  }

  async function deleteSemester(id: string) {
    try {
      const result = await daymark.deleteSemester(id);
      if (selectedSemesterId === id) setSelectedSemesterId(null);
      if (activeCourse?.semester_id === id) {
        setCurrentCourseId(null);
        setSelectedItem(null);
        setShowCourseDelete(false);
      }
      await refresh();
      showFeedback({
        message: t("app.toastSemesterDeleted", {
          count: result.course_count,
        }),
        duration: 4000,
      });
    } catch (cause) {
      setError(toUserMessage(cause));
      throw cause;
    }
  }

  async function editInformation(id: string, content: string) {
    try {
      await daymark.updateCourseInformation(id, content);
      await refresh();
    } catch (cause) {
      setError(toUserMessage(cause));
      throw cause;
    }
  }

  async function deleteInformation(id: string) {
    try {
      await daymark.deleteCourseInformation(id);
      await refresh();
    } catch (cause) {
      setError(toUserMessage(cause));
    }
  }

  async function resolvePending(
    captureId: string,
    resolution: ManualCaptureResolution,
    keepOne = false,
  ) {
    await daymark.resolveRawCapture(
      captureId,
      resolution,
      keepOne ? "KEEP_ONE" : null,
    );
    await refresh();
  }

  async function splitPending(
    captureId: string,
    resolutions: Extract<ManualCaptureResolution, { kind: "ITEM" }>[],
  ) {
    await daymark.resolveSplitCapture(captureId, resolutions);
    await refresh();
  }

  async function deferPending(captureId: string) {
    try {
      await daymark.deferRawCapture(captureId);
      setDismissedThisLaunch((ids) => new Set(ids).add(captureId));
    } catch (cause) {
      setError(toUserMessage(cause));
    }
  }

  async function deletePending(captureId: string) {
    try {
      await daymark.deleteUnresolvedCapture(captureId);
      await refresh();
    } catch (cause) {
      setError(toUserMessage(cause));
    }
  }

  async function resolveConflict(
    id: string,
    version: number,
    resolution: ConflictResolution,
  ) {
    const result = await resolveSyncConflict(id, version, resolution);
    setSyncConflicts(result.conflicts);
    retryAuthenticatedSync();
    if (result.undo)
      showFeedback({
        message: t("app.toastItemDeleted"),
        duration: 5000,
        action: async () => {
          await daymark.undoDelete(result.undo!.itemId, result.undo!.token);
          await refresh();
        },
      });
    await refresh();
  }

  async function inspectSyncIssue(issue: ActionRequiredSyncIssue) {
    const object = issue.local_object;
    switch (issue.mutation.entity_type) {
      case "ITEM": {
        const item = await daymark.getItem(issue.mutation.entity_id);
        if (item) await openItem(item);
        return;
      }
      case "COURSE_INFORMATION":
        setPage("courses");
        setCurrentCourseId(String(object?.course_id ?? "") || null);
        setCourseTab("information");
        return;
      case "COURSE_SCHEDULE_COLLECTION":
        setPage("courses");
        setCurrentCourseId(issue.mutation.entity_id);
        setCourseTab("schedule");
        return;
      case "SEMESTER_WEEK_COLLECTION":
      case "SEMESTER":
        setPage("courses");
        setCurrentCourseId(null);
        setSelectedSemesterId(issue.mutation.entity_id);
        return;
      case "COURSE":
        setPage("courses");
        setCurrentCourseId(issue.mutation.entity_id);
        return;
      default:
        setPage("overview");
    }
  }

  async function retrySyncIssue(mutationId: string) {
    setSyncIssues(await retryActionRequiredIssue(mutationId));
    showFeedback({ message: t("app.toastResubmitted"), duration: 3500 });
    await refresh();
  }

  async function abandonSyncIssue(mutationId: string) {
    setSyncIssues(await abandonActionRequiredIssue(mutationId));
    showFeedback({ message: t("app.toastRestoring"), duration: 3500 });
    await refresh();
  }

  const activeCourse = courses.find((course) => course.id === currentCourseId);
  const activeSemesterId = semesterForDate(localDate(), semesters)?.id ?? null;
  const targetSemesterId = selectedSemesterId ?? activeSemesterId;
  const visibleCourses = courses.filter((course) =>
    selectedSemesterId
      ? course.semester_id === selectedSemesterId
      : course.semester_id === activeSemesterId || course.semester_id === null,
  );
  const incompleteCounts = Object.fromEntries(
    courses.map((course) => [
      course.id,
      allItems.filter(
        (item) =>
          item.course_id === course.id &&
          item.status === "INCOMPLETE" &&
          item.deleted_at === null,
      ).length,
    ]),
  );
  const activeCourseSemester = semesters.find(
    (semester) => semester.id === activeCourse?.semester_id,
  );
  const pendingQuestions = unresolved.filter(
    (capture) => !dismissedThisLaunch.has(capture.id),
  );

  function openSearch() {
    setHighlightedInformationId(null);
    setSearchOpen(true);
  }

  function openCourseFromSearch(course: Course) {
    setSearchOpen(false);
    closeItemDetail();
    setPage("courses");
    setCurrentCourseId(course.id);
    setCourseTab("items");
    setShowCourseDelete(false);
  }

  function openInformationFromSearch(entry: CourseInformation) {
    setSearchOpen(false);
    closeItemDetail();
    setPage("courses");
    setCurrentCourseId(entry.course_id);
    setCourseTab("information");
    setHighlightedInformationId(entry.id);
    setShowCourseDelete(false);
  }

  function navigate(nextPage: PrimaryPage) {
    setPage(nextPage);
    setSearchOpen(false);
    setHighlightedInformationId(null);
    closeItemDetail();
    setShowCourseDelete(false);
  }

  function openCompletedAiTask(kind: AiTaskKind) {
    if (kind === "course-import") {
      navigate("courses");
      setImportOpenSignal((value) => value + 1);
    } else if (kind === "course-commit") {
      // The commit's result is the courses themselves: land on the list.
      navigate("courses");
    } else {
      navigate("overview");
      setPendingExpanded(true);
    }
  }

  return (
    <div className="app-shell">
      <WindowTitleBar />
      {availableUpdate ? (
        <UpdateDialog
          version={availableUpdate.version}
          body={availableUpdate.body ?? null}
          install={() => installUpdate(availableUpdate)}
          onDismiss={() => {
            releaseUpdate(availableUpdate);
            setAvailableUpdate(null);
          }}
        />
      ) : null}
      {/* First-launch permission guide — Android only, renders null elsewhere. */}
      <FirstLaunchGuide />
      {updateReady ? (
        <div
          className="update-dialog"
          role="dialog"
          aria-label={t("app.updateReadyTitle")}
        >
          <p className="update-dialog-title">{t("app.updateReadyBody")}</p>
          <p className="update-dialog-notes">{t("app.updateReadyHint")}</p>
          {updatePermissionHint ? (
            <p className="update-dialog-notes">
              {t("app.updatePermissionHint")}
            </p>
          ) : null}
          <div className="update-dialog-actions">
            <button
              type="button"
              onClick={() => {
                setUpdatePermissionHint(false);
                setUpdateReady(false);
              }}
            >
              {t("common.later")}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setUpdatePermissionHint(false);
                void openReadyUpdate().then((outcome) => {
                  // Keep the card when a system grant is needed first —
                  // the marker stays set and the install continues when
                  // the user returns.
                  if (outcome === "permission") {
                    setUpdatePermissionHint(true);
                  } else {
                    setUpdateReady(false);
                  }
                });
              }}
            >
              {t("app.installNow")}
            </button>
          </div>
        </div>
      ) : null}
      <div className="top-tools">
        <LanguageSwitcher variant="compact" />
        <AccountControl
          online={online}
          status={syncStatus}
          attentionCount={syncConflicts.length + syncIssues.length}
          onOpenRepair={() => setRepairOpenSignal((value) => value + 1)}
          onOpenCompletedTask={openCompletedAiTask}
        />
      </div>
      <AppNavigation page={page} onNavigate={navigate} onSearch={openSearch} />
      <main className="main-content">
        {!online && (
          <div className="connection-status" role="status">
            <span aria-hidden="true" />
            <div>
              <strong>{t("app.offlineTitle")}</strong>
              <small>{t("app.offlineBody")}</small>
            </div>
          </div>
        )}
        <ConflictPanel
          conflicts={syncConflicts}
          courses={courses}
          semesters={semesters}
          onResolve={resolveConflict}
        />
        <SyncRepairPanel
          openSignal={repairOpenSignal}
          issues={syncIssues}
          courses={courses}
          onInspect={(issue) => void inspectSyncIssue(issue)}
          onRetry={retrySyncIssue}
          onAbandon={abandonSyncIssue}
        />
        {initializing && (
          <section className="surface-state loading-state" aria-busy="true">
            <span className="loading-mark" aria-hidden="true" />
            <div>
              <h1>{t("app.loadingTitle")}</h1>
              <p>{t("app.loadingBody")}</p>
            </div>
          </section>
        )}
        {!initializing && page === "overview" && (
          <div
            key={`overview:${selectedSemesterId ?? "current"}`}
            className="page-transition"
          >
            <header className="page-header">
              <div className="page-title-block">
                <p className="eyebrow">ITEMS</p>
                <h1>{t("app.overviewTitle")}</h1>
                <p className="page-deck">{t("app.overviewDeck")}</p>
              </div>
              <div className="page-header-tools">
                <GlobalSearchButton onOpen={openSearch} />
                <SemesterSwitcher
                  semesters={semesters}
                  selectedId={selectedSemesterId}
                  onChange={(id) => {
                    setSelectedSemesterId(id);
                    setCurrentCourseId(null);
                  }}
                />
              </div>
            </header>
            {pendingQuestions.length > 0 && (
              <section
                className={`attention-panel ambiguity-panel ${pendingExpanded ? "expanded" : ""}`}
                aria-label={t("app.needsContextTitle")}
              >
                <AttentionSummary
                  eyebrow="NEEDS CONTEXT"
                  title={t("app.needsContextTitle")}
                  description={
                    pendingQuestions.length === 1
                      ? t("app.needsContextOne")
                      : t("app.needsContextMany")
                  }
                  count={pendingQuestions.length}
                  expanded={pendingExpanded}
                  tone="ambiguity"
                  onToggle={() => setPendingExpanded((value) => !value)}
                />
                {pendingExpanded && (
                  <div className="attention-body ambiguity-body">
                    {pendingQuestions.map((capture) => (
                      <PendingCapture
                        key={capture.id}
                        capture={capture}
                        courses={courses}
                        contextCourseId={unresolvedContexts[capture.id] ?? null}
                        onResolve={(resolution, keepOne) =>
                          resolvePending(capture.id, resolution, keepOne)
                        }
                        onSplit={(resolutions) =>
                          splitPending(capture.id, resolutions)
                        }
                        onInterpret={
                          authClient
                            ? () =>
                                requestCaptureInterpretation(
                                  capture.id,
                                  unresolvedContexts[capture.id] ?? null,
                                  courses
                                    .filter((course) =>
                                      capture.raw_text.includes(course.name),
                                    )
                                    .slice(0, 20)
                                    .map((course) => course.id),
                                )
                            : undefined
                        }
                        onDefer={() => deferPending(capture.id)}
                        onDelete={() => deletePending(capture.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
            <ItemList
              items={overviewItems}
              courses={courses}
              pendingMoveIds={pendingMoveIds}
              pendingDeleteIds={pendingDeleteIds}
              enteringItemIds={enteringItemIds}
              selectedItemId={selectedItem?.id ?? null}
              onOpen={(item) => void openItem(item)}
              onComplete={(item) => void complete(item)}
            />
          </div>
        )}
        {!initializing && page === "courses" && (
          <div
            key={`courses:${activeCourse?.id ?? "index"}:${selectedSemesterId ?? "current"}`}
            className="page-transition"
          >
            <header
              className={`page-header ${activeCourse ? "course-page-header" : ""}`}
            >
              <div className="page-title-block">
                {activeCourse && (
                  <button
                    type="button"
                    className="back-link"
                    onClick={() => {
                      setCurrentCourseId(null);
                      setShowCourseDelete(false);
                    }}
                  >
                    <span aria-hidden="true">←</span> {t("app.backToCourses")}
                  </button>
                )}
                <p className="eyebrow">COURSES</p>
                <h1>{activeCourse?.name ?? t("nav.courses")}</h1>
                <p className="page-deck">
                  {activeCourse
                    ? `${activeCourseSemester?.name ?? t("app.noSemester")} · ${t("app.openCount", { count: incompleteCounts[activeCourse.id] ?? 0 })}`
                    : t("app.coursesDeck")}
                </p>
              </div>
              <div className="page-header-tools">
                <GlobalSearchButton onOpen={openSearch} />
                <SemesterSwitcher
                  semesters={semesters}
                  selectedId={selectedSemesterId}
                  onChange={(id) => {
                    setSelectedSemesterId(id);
                    setCurrentCourseId(null);
                  }}
                />
                {activeCourse && (
                  <div className="course-header-actions">
                    <button
                      type="button"
                      className="text-button danger"
                      onClick={() => setShowCourseDelete(true)}
                    >
                      {t("app.deleteCourse")}
                    </button>
                  </div>
                )}
              </div>
            </header>
            {activeCourse ? (
              <>
                {showCourseDelete && (
                  <CourseDeleteConfirmation
                    course={activeCourse}
                    items={courseItems}
                    onCancel={() => setShowCourseDelete(false)}
                    onConfirm={deleteCourse}
                  />
                )}
                <div
                  className="course-tabs"
                  role="tablist"
                  aria-label={t("app.courseContent")}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={courseTab === "items"}
                    className={courseTab === "items" ? "selected" : ""}
                    onClick={() => setCourseTab("items")}
                  >
                    {t("app.tabItems")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={courseTab === "information"}
                    className={courseTab === "information" ? "selected" : ""}
                    onClick={() => setCourseTab("information")}
                  >
                    {t("app.tabInformation")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={courseTab === "schedule"}
                    className={courseTab === "schedule" ? "selected" : ""}
                    onClick={() => setCourseTab("schedule")}
                  >
                    {t("app.tabSchedule")}
                  </button>
                </div>
                <div key={courseTab} className="course-tab-content">
                  {courseTab === "items" ? (
                    <>
                      <form
                        className="course-item-form"
                        onSubmit={(event) => void addCourseItem(event)}
                      >
                        <input
                          value={courseItemText}
                          onChange={(event) =>
                            setCourseItemText(event.target.value)
                          }
                          placeholder={t("app.addItemPlaceholder")}
                          aria-label={t("app.addCourseItem")}
                        />
                        <button type="submit">{t("app.addItem")}</button>
                      </form>
                      <ItemList
                        items={courseItems}
                        courses={courses}
                        pendingMoveIds={pendingMoveIds}
                        pendingDeleteIds={pendingDeleteIds}
                        enteringItemIds={enteringItemIds}
                        selectedItemId={selectedItem?.id ?? null}
                        emptyLabel={t("app.emptyCourseItems")}
                        onOpen={(item) => void openItem(item)}
                        onComplete={(item) => void complete(item)}
                      />
                    </>
                  ) : courseTab === "information" ? (
                    <CourseInformationList
                      information={courseInformation}
                      highlightedId={highlightedInformationId}
                      onAdd={addInformation}
                      onEdit={editInformation}
                      onDelete={deleteInformation}
                    />
                  ) : (
                    <CourseScheduleList
                      schedules={courseSchedules}
                      onReplace={replaceSchedules}
                    />
                  )}
                </div>
              </>
            ) : (
              <CourseIndex
                key={targetSemesterId ?? "none"}
                courses={visibleCourses}
                targetSemesterId={targetSemesterId}
                semester={
                  semesters.find((value) => value.id === targetSemesterId) ??
                  null
                }
                weeks={semesterWeeks.filter(
                  (value) => value.semester_id === targetSemesterId,
                )}
                incompleteCounts={incompleteCounts}
                onOpen={(courseId) => {
                  setCurrentCourseId(courseId);
                  setShowCourseDelete(false);
                }}
                onFindCandidate={(name, semesterId) =>
                  daymark.priorCourseCandidate(name, semesterId)
                }
                onCreateCourse={async (name, semesterId, inheritFromId) => {
                  if (inheritFromId && semesterId)
                    await daymark.createCourseWithInheritance(
                      name,
                      semesterId,
                      inheritFromId,
                    );
                  else
                    await daymark.createCourse(name, semesterId, localDate());
                  await refresh();
                }}
                onCreateSemester={async (name, startDate, endDate) => {
                  await daymark.createSemester(name, startDate, endDate);
                  await refresh();
                }}
                onReplaceWeeks={async (values: WeekFields[]) => {
                  if (!targetSemesterId) return;
                  await daymark.replaceSemesterWeeks(targetSemesterId, values);
                  await refresh();
                }}
                onDeleteSemester={deleteSemester}
                openImportSignal={importOpenSignal}
                courseImportAvailable={Boolean(authClient)}
                onLoadPendingImports={pendingCourseImports}
                onStartImport={startCourseImport}
                onRetryImport={retryCourseImport}
                onResolveImport={resolveImportedCourse}
                onCommitImport={commitCourseImport}
                onDiscardImport={discardCourseImport}
                onImportCommitted={async () => {
                  await refresh();
                }}
              />
            )}
          </div>
        )}
        {!initializing && page === "calendar" && (
          <div key="calendar" className="page-transition">
            <header className="page-header">
              <div className="page-title-block">
                <p className="eyebrow">CALENDAR</p>
                <h1>{t("app.calendarTitle")}</h1>
                <p className="page-deck">{t("app.calendarDeck")}</p>
              </div>
              <div className="page-header-tools">
                <GlobalSearchButton onOpen={openSearch} />
              </div>
            </header>
            <CalendarView
              items={calendarItems}
              courses={courses}
              semesters={semesters}
              semesterWeeks={semesterWeeks}
              onOpen={(item) => void openItem(item)}
            />
          </div>
        )}
      </main>
      {searchOpen && (
        <SearchSurface
          items={allItems}
          courses={courses}
          courseInformation={searchCourseInformation}
          onClose={() => setSearchOpen(false)}
          onOpenItem={(item) => {
            setSearchOpen(false);
            void openItem(item);
          }}
          onOpenCourse={openCourseFromSearch}
          onOpenInformation={openInformationFromSearch}
        />
      )}
      {!initializing && <QuickCapture onSave={(text) => saveCapture(text)} />}
      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          courses={courses}
          rawCapture={selectedRaw}
          associations={itemAssociations.flatMap((association) => {
            const otherId =
              association.item_id_a === selectedItem.id
                ? association.item_id_b
                : association.item_id_a;
            const item = allItems.find((value) => value.id === otherId);
            return item ? [{ association, item }] : [];
          })}
          associationCandidates={allItems.filter(
            (item) =>
              item.deleted_at === null &&
              item.id !== selectedItem.id &&
              !itemAssociations.some(
                (association) =>
                  association.item_id_a === item.id ||
                  association.item_id_b === item.id,
              ),
          )}
          onClose={closeItemDetail}
          onComplete={(item) => void complete(item)}
          onRestore={(item) => void restore(item)}
          onDelete={remove}
          onSave={saveEdit}
          onAssociate={addItemAssociation}
          onRemoveAssociation={removeItemAssociation}
        />
      )}
      {feedback && (
        <TransientFeedback
          key={feedback.id}
          feedback={feedback}
          onDismiss={() => setFeedback(null)}
          onError={(cause) => setError(toUserMessage(cause))}
        />
      )}
      {error && (
        <ErrorNotice
          key={error}
          message={error}
          onDismiss={() => setError(null)}
        />
      )}
    </div>
  );
}
