import {
  TOT_CHARACTER_VIEW_BOX,
  totCharacter,
  type TotPose,
} from "@t3tools/client-runtime/tots/character";
import { SvgXml } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedSvgXml = withUniwind(SvgXml);

export function TotFace(props: {
  readonly character: string;
  readonly pose: TotPose;
  readonly size: number;
}) {
  return (
    <ThemedSvgXml
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      xml={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${TOT_CHARACTER_VIEW_BOX}" overflow="visible">${totCharacter(props.character).draw(props.pose)}</svg>`}
      width={props.size}
      height={props.size}
      colorClassName="accent-foreground-muted"
    />
  );
}
