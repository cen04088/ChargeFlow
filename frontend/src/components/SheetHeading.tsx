import { BottomSheet, IconButton } from "@toss/tds-mobile";

import closeIcon from "../assets/close.svg";

export function SheetHeading({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <BottomSheet.Header>
      <span className="sheet-heading">
        <span>{title}</span>
        <IconButton
          src={closeIcon}
          variant="clear"
          iconSize={20}
          aria-label="닫기"
          onClick={onClose}
        />
      </span>
    </BottomSheet.Header>
  );
}
