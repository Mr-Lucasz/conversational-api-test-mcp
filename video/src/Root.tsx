import type { FC } from "react";
import { AbsoluteFill, Composition, Html5Audio, Series, staticFile, Still, useCurrentFrame } from "remotion";
import { Frame } from "./components";
import { Cover } from "./Cover";
import { PostmanCover } from "./PostmanCover";
import { PostmanRun, postmanTotalFrames } from "./PostmanRun";
import { Cases, Chat, Checklist, Finding, Hook, Outro, Promises } from "./scenes";
import { scenes, totalFrames, video } from "./theme";

const order = [
  { duration: scenes.hook, Component: Hook },
  { duration: scenes.cases, Component: Cases },
  { duration: scenes.chat, Component: Chat },
  { duration: scenes.checklist, Component: Checklist },
  { duration: scenes.finding, Component: Finding },
  { duration: scenes.promises, Component: Promises },
  { duration: scenes.outro, Component: Outro },
];

const Promo: FC = () => {
  const frame = useCurrentFrame();
  let elapsed = 0;
  let step = order.length;
  for (let i = 0; i < order.length; i++) {
    elapsed += order[i].duration;
    if (frame < elapsed) {
      step = i + 1;
      break;
    }
  }
  return (
    <AbsoluteFill>
      <Html5Audio src={staticFile("audio/music.wav")} volume={0.12} />
      <Frame step={step} steps={order.length} />
      <Series>
        {order.map(({ duration, Component }, index) => (
          <Series.Sequence key={index} durationInFrames={duration}>
            <Component />
          </Series.Sequence>
        ))}
      </Series>
    </AbsoluteFill>
  );
};

export const Root: FC = () => (
  <>
    <Composition
      id="Promo"
      component={Promo}
      durationInFrames={totalFrames}
      fps={video.fps}
      width={video.width}
      height={video.height}
    />
    <Composition
      id="PostmanRun"
      component={PostmanRun}
      durationInFrames={postmanTotalFrames}
      fps={video.fps}
      width={video.width}
      height={video.height}
    />
    <Still id="Cover" component={Cover} width={video.width} height={video.height} />
    <Still id="PostmanCover" component={PostmanCover} width={video.width} height={video.height} />
  </>
);