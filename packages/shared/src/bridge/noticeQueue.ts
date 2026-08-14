export type NoticeOrigin = "host-poke" | "agent-authored";

export interface ChildBoundNoticeMetadata {
  origin: NoticeOrigin;
  sourceChild: string;
  sourceIncarnation?: number;
}

export interface UnboundNoticeMetadata {
  origin?: undefined;
  sourceChild?: undefined;
  sourceIncarnation?: undefined;
}

export type NoticeQueueMetadata = ChildBoundNoticeMetadata | UnboundNoticeMetadata;
